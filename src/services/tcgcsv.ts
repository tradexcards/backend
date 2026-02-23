/**
 * TCGCSVService — historical price archive management + bulk product catalog.
 *
 * Downloads daily .ppmd.7z archives, extracts them in parallel,
 * and fetches the full product catalog from TCGCSV live endpoints.
 */

import {
    existsSync,
    readdirSync,
    statSync,
    unlinkSync,
    renameSync,
    rmSync,
} from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { $ } from "bun";

import { env } from "../env";
import { log } from "../log";
import { db } from "./db";
import type { ProductInfo } from "../models";

const L = log("tcgcsv");

// ── Internal types ──────────────────────────────────────────────────────────

interface GroupData {
    groupId: number;
    name?: string;
    abbreviation?: string;
    categoryId?: number;
}

interface ExtendedDataEntry {
    name: string;
    displayName: string;
    value: string;
}

interface ProductData {
    productId: number;
    name: string;
    cleanName?: string;
    imageUrl?: string;
    categoryId?: number;
    groupId?: number;
    url?: string;
    modifiedOn?: string;
    extendedData?: ExtendedDataEntry[];
}

interface DownloadStats { checked: number; downloaded: number; skipped: number; failed: number }
interface ExtractStats  { extracted: number; skipped: number; failed: number }
interface CleanupStats  { archivesDeleted: number; directoriesDeleted: number }

// ── Category names ──────────────────────────────────────────────────────────

const CATEGORY_NAMES: Record<number, string> = {
    3: "Pokemon",
    85: "Pokemon - Japanese",
};

// ── Service ─────────────────────────────────────────────────────────────────

export class TCGCSVService {
    private cfg = env();
    private productNames = new Map<number, string>();
    private allProducts = new Map<number, ProductData>();
    private groupMap = new Map<number, GroupData>();
    private productsLoaded = false;
    private productsLock = false;

    /** TTL for per-group product cache entries (7 days). */
    private static readonly PRODUCTS_TTL = 7 * 86400;

    constructor() {}

    async init(): Promise<void> {
        // DB is already initialized globally — nothing to do here
    }

    // ── Date helpers ────────────────────────────────────────────────────────

    private getDateRange(days?: number): Date[] {
        const retentionDays = days ?? this.cfg.tcgcsv.retentionDays;
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - retentionDays);

        const first = new Date(this.cfg.tcgcsv.archiveStartDate);
        if (start < first) start.setTime(first.getTime());

        const dates: Date[] = [];
        const cur = new Date(start);
        while (cur <= end) {
            dates.push(new Date(cur));
            cur.setDate(cur.getDate() + 1);
        }
        return dates;
    }

    private fmt(d: Date): string { return d.toISOString().split("T")[0]; }
    private archiveName(d: Date): string { return `prices-${this.fmt(d)}.ppmd.7z`; }

    // ── Download ────────────────────────────────────────────────────────────

    private async downloadOne(date: Date): Promise<"downloaded" | "skipped" | "failed"> {
        const name = this.archiveName(date);
        const dest = join(this.cfg.paths.archives, name);

        if (existsSync(dest) && statSync(dest).size > 0) return "skipped";

        const url = `${this.cfg.tcgcsv.archiveUrl}/${name}`;
        try {
            const res = await fetch(url, {
                headers: { "User-Agent": this.cfg.tcgplayer.userAgent },
            });
            if (!res.ok) return "failed";
            const buf = await res.arrayBuffer();
            if (buf.byteLength === 0) return "failed";
            await writeFile(dest, Buffer.from(buf));
            return "downloaded";
        } catch (e) {
            L.error(`Download failed ${name}:`, e);
            return "failed";
        }
    }

    async downloadMissingArchives(days?: number): Promise<DownloadStats> {
        const dates = this.getDateRange(days);
        const stats: DownloadStats = { checked: 0, downloaded: 0, skipped: 0, failed: 0 };

        // Concurrent downloads (batches of 5)
        for (let i = 0; i < dates.length; i += 5) {
            const batch = dates.slice(i, i + 5);
            const results = await Promise.all(batch.map(d => this.downloadOne(d)));
            for (const r of results) {
                stats.checked++;
                if (r === "downloaded") stats.downloaded++;
                else if (r === "skipped") stats.skipped++;
                else stats.failed++;
            }
        }

        L.info(`Download: ${stats.downloaded} new, ${stats.skipped} cached, ${stats.failed} failed (${stats.checked} checked)`);
        return stats;
    }

    // ── Extraction ──────────────────────────────────────────────────────────

    private async extractOne(archivePath: string): Promise<boolean> {
        const filename = archivePath.split("/").pop() || "";
        const dateStr = filename.replace("prices-", "").replace(".ppmd.7z", "");
        const targetDir = join(this.cfg.paths.archivesJson, dateStr);

        // Already extracted?
        if (existsSync(targetDir)) {
            const children = readdirSync(targetDir);
            if (children.length > 0) {
                const first = children[0];
                const firstPath = join(targetDir, first);
                if (statSync(firstPath).isDirectory() && first !== dateStr) {
                    this.ensureJsonExtensions(targetDir);
                    return true; // already good
                }
                if (first === dateStr) {
                    this.flattenNested(targetDir, dateStr);
                    return true;
                }
            }
        }

        const tempDir = join(this.cfg.paths.archivesJson, `_temp_${dateStr}`);
        try {
            if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
            await mkdir(tempDir, { recursive: true });

            // Try 7z, then 7za
            try {
                await $`7z x ${archivePath} -o${tempDir} -y`.quiet();
            } catch {
                try {
                    await $`7za x ${archivePath} -o${tempDir} -y`.quiet();
                } catch {
                    L.error(`Extract failed ${filename}: 7z not found`);
                    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
                    return false;
                }
            }

            // Handle nested date folder from 7z
            const nestedDir = join(tempDir, dateStr);
            if (existsSync(nestedDir) && statSync(nestedDir).isDirectory()) {
                if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
                renameSync(nestedDir, targetDir);
                if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
            } else {
                if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
                renameSync(tempDir, targetDir);
            }

            this.ensureJsonExtensions(targetDir);
            return true;
        } catch (e) {
            L.error(`Extract failed ${filename}:`, e);
            if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
            return false;
        }
    }

    /** Extract all downloaded archives. Runs extractions in parallel. */
    async extractAllArchives(concurrency = 6): Promise<ExtractStats> {
        const stats: ExtractStats = { extracted: 0, skipped: 0, failed: 0 };

        const archives = readdirSync(this.cfg.paths.archives)
            .filter(f => f.endsWith(".7z"))
            .map(f => ({
                path: join(this.cfg.paths.archives, f),
                dateStr: f.replace("prices-", "").replace(".ppmd.7z", ""),
            }));

        // Figure out which need extraction
        const pending: string[] = [];
        for (const { path, dateStr } of archives) {
            const targetDir = join(this.cfg.paths.archivesJson, dateStr);
            if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
                stats.skipped++;
            } else {
                pending.push(path);
            }
        }

        // Parallel extraction in batches
        for (let i = 0; i < pending.length; i += concurrency) {
            const batch = pending.slice(i, i + concurrency);
            const results = await Promise.all(batch.map(p => this.extractOne(p)));
            for (const ok of results) {
                if (ok) stats.extracted++;
                else stats.failed++;
            }
        }

        L.info(`Extract: ${stats.extracted} new, ${stats.skipped} cached, ${stats.failed} failed`);
        return stats;
    }

    // ── Extraction helpers ──────────────────────────────────────────────────

    private flattenNested(targetDir: string, dateStr: string): void {
        const nestedDir = join(targetDir, dateStr);
        if (!existsSync(nestedDir)) return;
        try {
            for (const item of readdirSync(nestedDir)) {
                const src = join(nestedDir, item);
                const dest = join(targetDir, item);
                if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
                renameSync(src, dest);
            }
            if (existsSync(nestedDir)) rmSync(nestedDir, { recursive: true, force: true });
            this.ensureJsonExtensions(targetDir);
        } catch (e) {
            L.error(`Flatten failed ${dateStr}:`, e);
        }
    }

    private ensureJsonExtensions(dir: string): void {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                this.ensureJsonExtensions(full);
            } else if (entry.isFile() && !entry.name.endsWith(".json")) {
                try { renameSync(full, full + ".json"); } catch {}
            }
        }
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────

    cleanupOldData(): CleanupStats {
        const stats: CleanupStats = { archivesDeleted: 0, directoriesDeleted: 0 };
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - this.cfg.tcgcsv.retentionDays);

        // Clean archives
        for (const f of readdirSync(this.cfg.paths.archives).filter(f => f.endsWith(".7z"))) {
            try {
                const dateStr = f.replace("prices-", "").replace(".ppmd.7z", "");
                if (new Date(dateStr) < cutoff) {
                    unlinkSync(join(this.cfg.paths.archives, f));
                    stats.archivesDeleted++;
                }
            } catch {}
        }

        // Clean extracted dirs
        for (const d of readdirSync(this.cfg.paths.archivesJson, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name.startsWith("_")) continue;
            try {
                const dt = new Date(d.name);
                if (!isNaN(dt.getTime()) && dt < cutoff) {
                    rmSync(join(this.cfg.paths.archivesJson, d.name), { recursive: true, force: true });
                    stats.directoriesDeleted++;
                }
            } catch {}
        }

        return stats;
    }

    // ── Bulk product data from TCGCSV live API ──────────────────────────────

    private async fetchGroups(categoryId: number): Promise<GroupData[]> {
        const url = `${this.cfg.tcgcsv.baseUrl}/${categoryId}/groups`;
        try {
            const res = await fetch(url, {
                headers: { "User-Agent": this.cfg.tcgplayer.userAgent },
            });
            if (!res.ok) return [];
            const data = (await res.json()) as { results?: GroupData[] };
            return data.results ?? [];
        } catch (e) {
            L.error(`Groups fetch failed cat=${categoryId}:`, e);
            return [];
        }
    }

    private async fetchProductsForGroup(categoryId: number, groupId: number): Promise<ProductData[]> {
        const cacheKey = `products_${categoryId}_${groupId}`;
        const cached = db().cacheGet<ProductData[]>("tcgcsv_products", cacheKey);
        if (cached) return cached;

        const url = `${this.cfg.tcgcsv.baseUrl}/${categoryId}/${groupId}/products`;
        try {
            const res = await fetch(url, {
                headers: { "User-Agent": this.cfg.tcgplayer.userAgent },
            });
            if (!res.ok) return [];
            const data = (await res.json()) as { results?: ProductData[] };
            const products = data.results ?? [];
            db().cacheSet("tcgcsv_products", cacheKey, products, TCGCSVService.PRODUCTS_TTL);
            return products;
        } catch (e) {
            L.error(`Products fetch failed ${categoryId}/${groupId}:`, e);
            return [];
        }
    }

    /** Fetch full product catalog for all tracked categories. */
    async loadAllProducts(): Promise<Map<number, ProductData>> {
        if (this.productsLoaded && this.allProducts.size > 0) return this.allProducts;

        if (this.productsLock) {
            while (this.productsLock) await new Promise(r => setTimeout(r, 100));
            return this.allProducts;
        }
        this.productsLock = true;

        try {
            // Try SQLite tcgcsv_products table first
            const dbCount = db().getTcgcsvProductCount();
            if (dbCount > 0) {
                const dbProducts = db().getAllTcgcsvProducts();
                for (const [pid, p] of dbProducts) {
                    const productData: ProductData = {
                        productId: p.productId,
                        name: p.name,
                        cleanName: p.cleanName,
                        imageUrl: p.imageUrl,
                        categoryId: p.categoryId,
                        groupId: p.groupId,
                        url: p.url,
                        extendedData: p.extendedData as ExtendedDataEntry[],
                    };
                    this.allProducts.set(pid, productData);
                    if (p.name) this.productNames.set(pid, p.name);
                    if (p.groupId && p.groupName) {
                        this.groupMap.set(p.groupId, {
                            groupId: p.groupId,
                            name: p.groupName,
                            abbreviation: p.groupAbbr,
                            categoryId: p.categoryId,
                        });
                    }
                }
                this.productsLoaded = true;
                L.info(`Loaded ${this.allProducts.size} products from SQLite (${this.groupMap.size} groups)`);
                return this.allProducts;
            }

            L.info("Fetching bulk product data...");

            // Phase 1: groups
            const allGroups: { categoryId: number; group: GroupData }[] = [];
            for (const catId of this.cfg.analysis.categories) {
                const groups = await this.fetchGroups(catId);
                for (const g of groups) {
                    if (g.groupId) {
                        allGroups.push({ categoryId: catId, group: g });
                        this.groupMap.set(g.groupId, { ...g, categoryId: catId });
                    }
                }
            }
            L.info(`${allGroups.length} groups, fetching products...`);

            // Phase 2: products (batched concurrency 10)
            for (let i = 0; i < allGroups.length; i += 10) {
                const batch = allGroups.slice(i, i + 10);
                const results = await Promise.all(
                    batch.map(g => this.fetchProductsForGroup(g.categoryId, g.group.groupId)),
                );
                for (const products of results) {
                    for (const p of products) {
                        if (p.productId && p.name) {
                            this.allProducts.set(p.productId, p);
                            this.productNames.set(p.productId, p.name);
                        }
                    }
                }
            }

            this.productsLoaded = true;

            // Persist to SQLite tcgcsv_products table
            const payload = Array.from(this.allProducts.values()).map(p => {
                const g = p.groupId ? this.groupMap.get(p.groupId) : undefined;
                return {
                    productId: p.productId,
                    name: p.name,
                    cleanName: p.cleanName,
                    imageUrl: p.imageUrl,
                    categoryId: p.categoryId,
                    groupId: p.groupId,
                    url: p.url,
                    extendedData: p.extendedData as unknown[],
                    groupName: g?.name,
                    groupAbbr: g?.abbreviation,
                };
            });
            const written = db().upsertTcgcsvProductBatch(payload);
            L.info(`Loaded ${this.allProducts.size} products (${this.groupMap.size} groups), wrote ${written} to SQLite`);

            return this.allProducts;
        } finally {
            this.productsLock = false;
        }
    }

    getAllProductNames(): Map<number, string> { return this.productNames; }

    /** Build ProductInfo objects from bulk data for the given IDs. */
    buildProductInfoBatch(ids: number[]): ProductInfo[] {
        const results: ProductInfo[] = [];
        for (const pid of ids) {
            const p = this.allProducts.get(pid);
            if (!p) continue;

            const group = p.groupId ? this.groupMap.get(p.groupId) : undefined;
            let rarity = "";
            let productType = "Cards";
            if (p.extendedData) {
                const r = p.extendedData.find(e => e.name === "Rarity");
                if (r) rarity = r.value;
                // Sealed products (booster boxes, packs, ETBs, etc.) lack "Number"
                // in extendedData, while every real card has a set number.
                const hasNumber = p.extendedData.some(e => e.name === "Number");
                if (!hasNumber) productType = "Sealed Products";
            } else {
                // No extendedData at all — not a card
                productType = "Sealed Products";
            }

            results.push({
                product_id: pid,
                product_name: p.name,
                set_name: group?.name ?? "",
                set_code: group?.abbreviation ?? "",
                rarity_name: rarity,
                product_type_name: productType,
                product_line_name: CATEGORY_NAMES[p.categoryId ?? 0] ?? "Pokemon",
                image_url: p.imageUrl
                    ? p.imageUrl.replace("_200w", "_400w")
                    : `https://tcgplayer-cdn.tcgplayer.com/product/${pid}_400w.jpg`,
                url: p.url ?? `https://www.tcgplayer.com/product/${pid}`,
                skus: [],
            });
        }
        return results;
    }

    // ── Query helpers ───────────────────────────────────────────────────────

    getAvailableDates(): string[] {
        if (!existsSync(this.cfg.paths.archivesJson)) return [];
        return readdirSync(this.cfg.paths.archivesJson, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith("_"))
            .map(d => d.name)
            .filter(n => !isNaN(new Date(n).getTime()))
            .sort();
    }

    /** High-level: download → extract → cleanup. */
    async sync(days?: number) {
        const download = await this.downloadMissingArchives(days);
        const extract = await this.extractAllArchives();
        const cleanup = this.cleanupOldData();
        return { download, extract, cleanup };
    }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: TCGCSVService | null = null;

export async function initTcgcsv(): Promise<TCGCSVService> {
    if (!_instance) {
        _instance = new TCGCSVService();
        await _instance.init();
    }
    return _instance;
}

export function tcgcsv(): TCGCSVService {
    if (!_instance) throw new Error("TCGCSVService not initialized — call initTcgcsv() first");
    return _instance;
}
