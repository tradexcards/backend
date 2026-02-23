/**
 * LoopManager — recurring background task scheduler.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type ProgressFn = (current: number, total: number) => void;

export interface TaskResult {
    ok: number;
    fail: number;
    detail?: string;
}

export type TaskFn = (progress: ProgressFn) => Promise<TaskResult>;

export interface LoopConfig {
    name: string;
    intervalMs: number;
    task: TaskFn;
    immediate?: boolean;
    paused?: boolean;
}

export type LoopState = "idle" | "running" | "paused";

export interface LoopStatus {
    name: string;
    state: LoopState;
    intervalMs: number;
    progress: number | null;
    lastOk: number;
    lastFail: number;
    lastDetail: string | null;
    lastDurationMs: number | null;
    lastRunAt: number | null;
    nextRunAt: number | null;
    runCount: number;
}

// ── Internal state ──────────────────────────────────────────────────────────

interface LoopEntry {
    config: LoopConfig;
    state: LoopState;
    timer: ReturnType<typeof setInterval> | null;
    progressCurrent: number;
    progressTotal: number;
    lastOk: number;
    lastFail: number;
    lastDetail: string | null;
    lastDurationMs: number | null;
    lastRunAt: number | null;
    nextRunAt: number | null;
    runCount: number;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class LoopManager {
    private loops = new Map<string, LoopEntry>();
    private started = false;

    register(id: string, config: LoopConfig): void {
        if (this.loops.has(id)) throw new Error(`Loop "${id}" already registered`);
        this.loops.set(id, {
            config,
            state: config.paused ? "paused" : "idle",
            timer: null,
            progressCurrent: 0, progressTotal: 0,
            lastOk: 0, lastFail: 0, lastDetail: null,
            lastDurationMs: null, lastRunAt: null, nextRunAt: null,
            runCount: 0,
        });
    }

    startAll(): void {
        if (this.started) return;
        this.started = true;
        for (const [id, entry] of this.loops) {
            if (entry.state !== "paused") this.scheduleLoop(id, entry);
        }
    }

    stopAll(): void {
        for (const [, entry] of this.loops) {
            if (entry.timer) { clearInterval(entry.timer); entry.timer = null; }
            entry.nextRunAt = null;
        }
        this.started = false;
    }

    pause(id: string): void {
        const e = this.getEntry(id);
        if (e.timer) { clearInterval(e.timer); e.timer = null; }
        if (e.state !== "running") e.state = "paused";
        e.nextRunAt = null;
    }

    resume(id: string): void {
        const e = this.getEntry(id);
        if (e.state !== "paused") return;
        e.state = "idle";
        if (this.started) this.scheduleLoop(id, e);
    }

    async runOnce(id: string): Promise<TaskResult> {
        return this.executeRun(id, this.getEntry(id));
    }

    getStatus(): LoopStatus[] {
        return [...this.loops.values()].map(e => ({
            name: e.config.name,
            state: e.state,
            intervalMs: e.config.intervalMs,
            progress: e.state === "running" && e.progressTotal > 0
                ? e.progressCurrent / e.progressTotal : null,
            lastOk: e.lastOk, lastFail: e.lastFail,
            lastDetail: e.lastDetail,
            lastDurationMs: e.lastDurationMs,
            lastRunAt: e.lastRunAt, nextRunAt: e.nextRunAt,
            runCount: e.runCount,
        }));
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private getEntry(id: string): LoopEntry {
        const e = this.loops.get(id);
        if (!e) throw new Error(`Loop "${id}" not found`);
        return e;
    }

    private scheduleLoop(id: string, entry: LoopEntry): void {
        if (entry.config.immediate) {
            this.executeRun(id, entry).catch(e =>
                log(`loop:${entry.config.name}`).error("Uncaught error:", e));
        }
        entry.nextRunAt = Date.now() + entry.config.intervalMs;
        entry.timer = setInterval(() => {
            if (entry.state === "running") return;
            this.executeRun(id, entry).catch(e =>
                log(`loop:${entry.config.name}`).error("Uncaught error:", e));
        }, entry.config.intervalMs);
    }

    private async executeRun(_id: string, entry: LoopEntry): Promise<TaskResult> {
        entry.state = "running";
        entry.progressCurrent = 0;
        entry.progressTotal = 0;
        const t0 = Date.now();

        let result: TaskResult;
        try {
            result = await entry.config.task((cur, total) => {
                entry.progressCurrent = cur;
                entry.progressTotal = total;
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(`loop:${entry.config.name}`).error(`Error: ${msg}`);
            result = { ok: 0, fail: 1, detail: `Error: ${msg}` };
        }

        entry.lastOk = result.ok;
        entry.lastFail = result.fail;
        entry.lastDetail = result.detail ?? null;
        entry.lastDurationMs = Date.now() - t0;
        entry.lastRunAt = Date.now();
        entry.runCount++;
        entry.progressCurrent = 0;
        entry.progressTotal = 0;
        entry.state = this.started ? "idle" : "paused";
        if (entry.timer) entry.nextRunAt = Date.now() + entry.config.intervalMs;

        const dur = entry.lastDurationMs < 1000
            ? `${entry.lastDurationMs}ms`
            : `${(entry.lastDurationMs / 1000).toFixed(1)}s`;
        log(`loop:${entry.config.name}`).info(`ok=${result.ok} fail=${result.fail} dur=${dur}${result.detail ? ` (${result.detail})` : ""}`);

        return result;
    }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: LoopManager | null = null;

export function loops(): LoopManager {
    if (!_instance) _instance = new LoopManager();
    return _instance;
}

// ── Built-in tasks ──────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { env, readActiveProductIds } from "../env";
import { log } from "../log";

/**
 * Daily sync task: download → extract → catalog → warm pricing → analyze → write top.txt
 *
 * The pricing warm step ensures the analyzer has live liquidity data
 * (listings, sellers, spread) so the 3-pillar scoring works correctly.
 * Without it, the analysis falls back to volatility-only heuristics.
 */
export function dailySyncTask(): TaskFn {
    return async (progress) => {
        const L = log("sync");
        // Lazy imports to avoid circular dependency at module load
        const { tcgcsv } = await import("./tcgcsv");
        const { analyzer } = await import("./analyzer");
        const { tcgplayer } = await import("./tcgplayer");

        const cfg = env();
        const csv = tcgcsv();
        const ana = analyzer();
        const client = tcgplayer();

        progress(0, 6);

        // Step 1: Download archives for the configured retention window
        L.info(`Step 1/6: Downloading last ${cfg.tcgcsv.retentionDays} days of archives...`);
        const dl = await csv.downloadMissingArchives(cfg.tcgcsv.retentionDays);
        progress(1, 6);

        // Step 2: Extract (parallel)
        L.info("Step 2/6: Extracting archives...");
        const ex = await csv.extractAllArchives(8);
        progress(2, 6);

        // Step 3: Fetch latest product data
        L.info("Step 3/6: Fetching product catalog...");
        await csv.loadAllProducts();
        const names = csv.getAllProductNames();
        ana.loadBulkProductNames(names);
        progress(3, 6);

        // Step 4: Warm pricing cache for candidate products
        // This gives the analyzer live liquidity data (listings, sellers, spread)
        // so the scoring doesn't collapse to volatility-only.
        L.info("Step 4/6: Warming pricing cache for analysis...");
        const topN = cfg.pricing.topProductCount;
        // Read top.txt if it exists (from a previous run), otherwise use all product IDs
        const candidateIds = readActiveProductIds(topN);
        if (candidateIds.length > 0) {
            const warmResult = await client.fetchAllPricingParallel(candidateIds, 1);
            const warmDur = warmResult.duration < 1000
                ? `${warmResult.duration}ms`
                : `${(warmResult.duration / 1000).toFixed(1)}s`;
            L.info(`Warmed pricing for ${warmResult.fetched}/${candidateIds.length} products in ${warmDur}`);
        } else {
            L.info("No candidate IDs yet — skipping pricing warm (cold boot)");
        }
        progress(4, 6);

        // Step 5: Analyze (now with live pricing data available)
        L.info("Step 5/6: Analyzing cards...");
        const result = await ana.analyze(true);
        progress(5, 6);

        // Step 6: Write top.txt (all cards, decreasing activity score)
        L.info("Step 6/6: Writing top.txt...");
        const topPath = join(cfg.paths.root, "top.txt");
        const lines = result.all_cards.map(c => String(c.product_id));
        await writeFile(topPath, lines.join("\n") + "\n");
        L.info(`Wrote ${lines.length} product IDs to top.txt`);
        progress(6, 6);

        return {
            ok: dl.downloaded + ex.extracted + result.all_cards.length,
            fail: dl.failed + ex.failed,
            detail: `dl=${dl.downloaded}/${dl.checked} ex=${ex.extracted} cards=${result.all_cards.length} top=${lines.length}`,
        };
    };
}

/**
 * Prefetch loop task: warm the listings, sales, and price history caches
 * for the top N products from top.txt. Processes in small batches to
 * avoid hammering TCGPlayer.
 */
export function prefetchTask(): TaskFn {
    return async (progress) => {
        const L = log("prefetch");
        const { tcgplayer } = await import("./tcgplayer");
        const cfg = env();

        const batchSize = cfg.prefetch.batchSize;
        const ids = readActiveProductIds(cfg.prefetch.topCount);
        if (ids.length === 0) {
            L.warn("No active product IDs — skipping");
            return { ok: 0, fail: 0, detail: "no IDs" };
        }

        L.info(`Warming caches for ${ids.length} products (batch=${batchSize})...`);

        const client = tcgplayer();
        let ok = 0;
        let fail = 0;
        const t0 = Date.now();

        progress(0, ids.length);

        // Process in batches
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);

            const results = await Promise.allSettled(
                batch.map(async (pid) => {
                    // Fetch all four data types in parallel for each product
                    const [listings, sales, histMonth, histAnnual] = await Promise.allSettled([
                        client.getListings(pid),
                        client.getSales(pid),
                        client.getHistory(pid, "month"),
                        client.getHistory(pid, "annual"),
                    ]);

                    const failures = [listings, sales, histMonth, histAnnual]
                        .filter(r => r.status === "rejected").length;

                    return failures === 0;
                }),
            );

            for (const r of results) {
                if (r.status === "fulfilled" && r.value) ok++;
                else fail++;
            }

            progress(Math.min(i + batch.length, ids.length), ids.length);
        }

        const dur = Date.now() - t0;
        const durStr = dur < 1000 ? `${dur}ms` : `${(dur / 1000).toFixed(1)}s`;

        L.info(`Done: ${ok}/${ids.length} ok, ${fail} failed, ${durStr}`);

        return {
            ok,
            fail,
            detail: `${ok}/${ids.length} in ${durStr}`,
        };
    };
}

/**
 * Market stats loop task: refresh the in-memory market stats cache
 * by batch-fetching all on-chain market accounts + oracle prices.
 * This provides the dashboard with volume-sorted ordering without
 * requiring the frontend to make separate RPC calls.
 */
export function marketStatsTask(): TaskFn {
    return async (progress) => {
        const L = log("market-stats");
        const { perpdex } = await import("./perpdex");

        const ids = readActiveProductIds(200); // all active products
        if (ids.length === 0) {
            L.warn("No active product IDs — skipping market stats refresh");
            return { ok: 0, fail: 0, detail: "no IDs" };
        }

        progress(0, 1);
        L.info(`Refreshing market stats cache for ${ids.length} products...`);

        const svc = perpdex();
        const result = await svc.refreshMarketStatsCache(ids);

        progress(1, 1);

        return {
            ok: result.updated,
            fail: result.failed,
            detail: `${result.updated}/${ids.length} markets cached`,
        };
    };
}

/**
 * Pricing loop task: read top N product IDs from top.txt, fetch live prices in parallel,
 * then push updated prices to ER via the oracle keeper (if enabled).
 * Also broadcasts price updates to all connected WebSocket clients.
 */
export function pricingTask(): TaskFn {
    return async (progress) => {
        const L = log("pricing");
        const { tcgplayer } = await import("./tcgplayer");
        const { broadcastPriceUpdate } = await import("../routes/ws");
        const cfg = env();

        const ids = readActiveProductIds(cfg.pricing.topProductCount);
        if (ids.length === 0) {
            L.warn("No active product IDs — skipping pricing loop");
            return { ok: 0, fail: 0, detail: "no IDs" };
        }

        L.info(`Fetching live prices for ${ids.length} products...`);

        const client = tcgplayer();
        const result = await client.fetchAllPricingParallel(ids, 1, (done, total) => {
            progress(done, total);
        });

        const dur = result.duration < 1000
            ? `${result.duration}ms`
            : `${(result.duration / 1000).toFixed(1)}s`;

        L.info(`Done: ${result.fetched}/${ids.length} fetched, ${result.failed} failed, ${dur}`);

        // Broadcast price updates to WebSocket clients
        const priceUpdates: Array<{ productId: number; price: number; source: string }> = [];
        for (const [productId, pricing] of result.results) {
            if (pricing.market_price != null) {
                priceUpdates.push({
                    productId,
                    price: pricing.market_price,
                    source: "tcgplayer",
                });
            }
        }
        if (priceUpdates.length > 0) {
            broadcastPriceUpdate(priceUpdates);
        }

        // Update in-memory price cache via the oracle keeper
        let cached = 0;
        if (cfg.keeper.enabled) {
            try {
                const { keeper } = await import("./oracle/keeper");
                const k = keeper();
                if (k?.isRunning()) {
                    const cacheResult = await k.runUpdateCycle();
                    cached = cacheResult.updated;
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                L.error(`Price cache update failed: ${msg}`);
            }
        }

        const cacheSuffix = cached > 0 ? ` cached=${cached}` : "";

        return {
            ok: result.fetched,
            fail: result.failed,
            detail: `${result.fetched}/${ids.length} in ${dur}${cacheSuffix}`,
        };
    };
}

/**
 * Liquidation loop task: scan all open positions and liquidate any that
 * are underwater based on cached oracle prices. Runs as a background
 * task at a configurable interval (default 30s).
 *
 * Uses the keeper's `scanAndLiquidate()` method which:
 *   1. Fetches all Position accounts via getProgramAccounts
 *   2. Compares cached prices against liquidation prices
 *   3. Sends VersionedTransaction (Ed25519SigVerify + liquidate_keeper) for each
 */
export function liquidationTask(): TaskFn {
    return async (progress) => {
        const L = log("liquidation");
        const cfg = env();

        if (!cfg.keeper.enabled) {
            return { ok: 0, fail: 0, detail: "keeper disabled" };
        }

        const { keeper } = await import("./oracle/keeper");
        const k = keeper();
        if (!k || !k.isRunning()) {
            return { ok: 0, fail: 0, detail: "keeper not running" };
        }

        progress(0, 1);

        const result = await k.scanAndLiquidate();

        progress(1, 1);

        const detail = result.scanned > 0
            ? `scanned=${result.scanned} liquidated=${result.liquidated} errors=${result.errors}`
            : "no positions";

        return {
            ok: result.liquidated,
            fail: result.errors,
            detail,
        };
    };
}
