/**
 * TCGPlayerClient — live API client for TCGPlayer pricing data.
 *
 * Key features:
 *   - fetchAllPricingParallel() fires all requests at once (no queue, no rate limit)
 *   - Optional Bright Data proxy for hot-channel pricing requests
 *   - Rotating user agents per-request to avoid fingerprinting
 *   - Persistent file-backed caches (pricing 5 min, product_info 30 days)
 *   - getCachedPricingRaw() returns stale data for oracle use
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { env } from "../env";
import { log } from "../log";
import { db } from "./db";

const L = log("tcgplayer");
import type {
    ProductDetails,
    ProductInfo,
    ProductPricing,
    Listing,
    Sale,
    PriceHistory,
    PriceHistoryBucket,
    SkuHistory,
} from "../models";

// ── Rotating user agents ────────────────────────────────────────────────────

const USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
];

function randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Proxy config ────────────────────────────────────────────────────────────

interface ProxyConfig {
    /** Full proxy URL: http://user-country-XX:pass@host:port */
    url: string;
    /** PEM-encoded CA certificate for TLS interception */
    caCert: string;
}

function buildProxyConfig(): ProxyConfig | null {
    const cfg = env().proxy;
    if (!cfg.enabled) return null;

    // Validate required credentials
    if (!cfg.user || !cfg.pass) {
        L.warn("Proxy enabled but PROXY_USER/PROXY_PASS not set — proxy disabled");
        return null;
    }

    if (!cfg.caCertPath) {
        L.warn("Proxy enabled but PROXY_CA_CERT_PATH not set — proxy disabled");
        return null;
    }

    // Resolve CA cert path relative to backend root
    const certPath = cfg.caCertPath.startsWith("/")
        ? cfg.caCertPath
        : resolve(env().paths.root, cfg.caCertPath);

    if (!existsSync(certPath)) {
        L.warn(`Proxy CA cert not found: ${certPath} — proxy disabled`);
        return null;
    }

    const proxyUser = `${cfg.user}-country-${cfg.country}`;
    const proxyUrl = `http://${proxyUser}:${cfg.pass}@${cfg.host}:${cfg.port}`;
    const caCert = readFileSync(certPath, "utf-8");

    L.info(`Proxy enabled: ${cfg.host}:${cfg.port} (${cfg.country.toUpperCase()})`);
    return { url: proxyUrl, caCert };
}

// ── Browser-like headers ────────────────────────────────────────────────────

function browserHeaders(productId?: number): Record<string, string> {
    const h: Record<string, string> = {
        "User-Agent": randomUA(),
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
    };
    if (productId) {
        h["Referer"] = `https://www.tcgplayer.com/product/${productId}`;
        h["Origin"] = "https://www.tcgplayer.com";
    }
    return h;
}

// ── Concurrency semaphore ────────────────────────────────────────────────────

class Semaphore {
    private queue: Array<() => void> = [];
    private active = 0;
    constructor(private readonly max: number) {}
    async acquire(): Promise<void> {
        if (this.active < this.max) { this.active++; return; }
        return new Promise<void>(resolve => this.queue.push(resolve));
    }
    release(): void {
        const next = this.queue.shift();
        if (next) { next(); }
        else { this.active--; }
    }
}

// ── Client ──────────────────────────────────────────────────────────────────

const TIMEOUT_MS = env().rateLimit.timeoutSeconds * 1000; // default 30s

export class TCGPlayerClient {
    private detailsBase: string;
    private listingsBase: string;
    private salesBase: string;
    private historyBase: string;
    private proxy: ProxyConfig | null = null;
    private cacheTtl: { pricing: number; listings: number; sales: number; history: number; productInfo: number };
    private initialized = false;
    /** In-flight deduplication map for background pricing refreshes. */
    private inflightPricing = new Map<number, Promise<ProductPricing | null>>();

    constructor() {
        const cfg = env().tcgplayer;
        this.detailsBase = `${cfg.searchApi}/v2/product`;
        this.listingsBase = `${cfg.searchApi}/v1/product`;
        this.salesBase = `${cfg.mpApi}/v2/product`;
        this.historyBase = `${cfg.historyApi}/price/history`;
        const cacheCfg = env().cache;
        this.cacheTtl = {
            pricing: cacheCfg.pricing,
            listings: cacheCfg.listings,
            sales: cacheCfg.sales,
            history: cacheCfg.history,
            productInfo: cacheCfg.productInfo,
        };
    }

    /** Async init: build proxy. DB is already initialized globally. */
    async init(): Promise<void> {
        if (this.initialized) return;

        this.proxy = buildProxyConfig();

        this.initialized = true;
        L.info(`Initialized (proxy=${this.proxy ? "on" : "off"}, ` +
            `pricing=${db().getPricingCount()}, info=${db().getProductCount()}, ` +
            `listings=${db().cacheSize("listings")}, sales=${db().cacheSize("sales")}, ` +
            `history=${db().cacheSize("history")})`);
    }

    // ── Single-product fetch ─────────────────────────────────────────────────

    /**
     * Get full product details (info + pricing). Cache strategy:
     *   1. Fresh pricing cache → return immediately
     *   2. Stale pricing cache → return stale, background refresh
     *   3. No cache → block on live fetch
     */
    async getProductDetails(productId: number): Promise<ProductDetails | null> {
        const row = db().getProduct(productId);
        const info: ProductInfo | null = row ? {
            product_id: row.product_id,
            product_name: row.product_name,
            set_name: row.set_name,
            set_code: row.set_code,
            rarity_name: row.rarity_name,
            product_type_name: row.product_type_name,
            product_line_name: row.product_line_name,
            image_url: row.image_url,
            url: row.url,
            skus: row.skus as Record<string, unknown>[],
        } : null;

        if (!info) {
            // No product info at all — need a live fetch to populate both
            const pricing = await this.fetchOnePricing(productId);
            if (!pricing) return null;
            const freshRow = db().getProduct(productId);
            if (!freshRow) return null;
            return { ...freshRow, skus: freshRow.skus as any, ...pricing };
        }

        // We have info — now get pricing with stale-while-revalidate
        const pricingAge = db().getPricingAge(productId);
        const pricingRow = db().getPricing(productId);

        if (pricingRow && pricingAge !== null && pricingAge <= this.cacheTtl.pricing) {
            // Fresh pricing
            return { ...info, ...pricingRow };
        }

        if (pricingRow) {
            // Stale pricing — serve it, deduplicated background refresh
            this.backgroundRefreshPricing(productId);
            return { ...info, ...pricingRow };
        }

        // No pricing at all — block on live fetch
        const pricing = await this.fetchOnePricing(productId);
        if (!pricing) return null;
        return { ...info, ...pricing };
    }

    async getProductInfo(productId: number): Promise<ProductInfo | null> {
        const row = db().getProduct(productId);
        if (!row) return null;
        return {
            product_id: row.product_id,
            product_name: row.product_name,
            set_name: row.set_name,
            set_code: row.set_code,
            rarity_name: row.rarity_name,
            product_type_name: row.product_type_name,
            product_line_name: row.product_line_name,
            image_url: row.image_url,
            url: row.url,
            skus: row.skus as Record<string, unknown>[],
        };
    }

    async getProductPricing(productId: number): Promise<ProductPricing | null> {
        const pricingAge = db().getPricingAge(productId);
        const pricingRow = db().getPricing(productId);

        if (pricingRow && pricingAge !== null && pricingAge <= this.cacheTtl.pricing) {
            // Fresh
            return pricingRow;
        }

        if (pricingRow) {
            // Stale — serve + deduplicated background refresh
            this.backgroundRefreshPricing(productId);
            return pricingRow;
        }

        // Nothing — block on live
        return this.fetchOnePricing(productId);
    }

    // ── Listings ───────────────────────────────────────────────────────────

    /**
     * Get listings for a product. Cache strategy:
     *   1. Fresh cache hit → return immediately
     *   2. Stale cache hit → return stale, background refresh
     *   3. No cache → block on live fetch
     */
    async getListings(
        productId: number,
        limit = 50,
        forceRefresh = false,
    ): Promise<Listing[]> {
        const cacheKey = `listings_${productId}`;

        if (!forceRefresh) {
            // 1. Fresh?
            const fresh = db().cacheGet<Listing[]>("listings", cacheKey);
            if (fresh) return fresh;

            // 2. Stale? Serve it, refresh in background
            const stale = db().cacheGetRaw<Listing[]>("listings", cacheKey);
            if (stale) {
                this._fetchListings(productId, limit).catch(e =>
                    L.debug(`Background listings refresh failed for ${productId}: ${e instanceof Error ? e.message : e}`)
                );
                return stale;
            }
        }

        // 3. Nothing cached — block on live fetch
        return this._fetchListings(productId, limit);
    }

    private async _fetchListings(productId: number, limit: number): Promise<Listing[]> {
        const url = `${this.listingsBase}/${productId}/listings`;
        const body = {
            filters: {
                term: { sellerStatus: "Live", channelId: 0 },
                range: { quantity: { gte: 1 } },
                exclude: { channelExclusion: 0 },
            },
            from: 0,
            size: limit,
            sort: { field: "price", order: "asc" },
            context: { shippingCountry: "US", cart: {} },
            aggregations: ["listingType"],
        };

        const proxyOpts: Record<string, unknown> = this.proxy
            ? { proxy: this.proxy.url, tls: { ca: this.proxy.caCert } }
            : {};

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    ...browserHeaders(productId),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
                ...proxyOpts,
            } as RequestInit);
            clearTimeout(timeoutId);

            if (!res.ok) {
                L.warn(`Listings ${productId} HTTP ${res.status}`);
                return [];
            }

            const json = (await res.json()) as Record<string, unknown>;
            const results = (json.results || []) as Array<{ results?: Array<Record<string, unknown>> }>;
            const listingsData = results[0]?.results || [];

            const listings: Listing[] = listingsData.map((item) => ({
                listing_id: String(item.listingId || 0),
                seller_name: String(item.sellerName || "Unknown"),
                condition: String(item.condition || "Near Mint"),
                price: Number(item.price || 0),
                quantity: Number(item.quantity || 1),
                shipping_price: Number(item.shippingPrice || 0),
                printing: String(item.printing || ""),
                language: String(item.language || "English"),
                seller_rating: item.sellerRating ? Number(item.sellerRating) : null,
                seller_sales: item.sellerSales ? String(item.sellerSales) : null,
                gold_seller: Boolean(item.goldSeller),
                verified_seller: Boolean(item.verifiedSeller),
            }));

            db().cacheSet("listings", `listings_${productId}`, listings, this.cacheTtl.listings);
            return listings;
        } catch (err) {
            clearTimeout(timeoutId);
            L.warn(`Listings ${productId} failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    // ── Sales ────────────────────────────────────────────────────────────────

    /**
     * Get recent sales. Same cache strategy as getListings.
     */
    async getSales(
        productId: number,
        limit = 25,
        forceRefresh = false,
    ): Promise<Sale[]> {
        const cacheKey = `sales_${productId}`;

        if (!forceRefresh) {
            const fresh = db().cacheGet<Sale[]>("sales", cacheKey);
            if (fresh) return fresh;

            const stale = db().cacheGetRaw<Sale[]>("sales", cacheKey);
            if (stale) {
                this._fetchSales(productId, limit).catch(e =>
                    L.debug(`Background sales refresh failed for ${productId}: ${e instanceof Error ? e.message : e}`)
                );
                return stale;
            }
        }

        return this._fetchSales(productId, limit);
    }

    private async _fetchSales(productId: number, limit: number): Promise<Sale[]> {
        const url = `${this.salesBase}/${productId}/latestsales`;
        const body = {
            conditions: [],
            languages: [],
            variants: [],
            listingType: "All",
            limit,
        };

        const proxyOpts: Record<string, unknown> = this.proxy
            ? { proxy: this.proxy.url, tls: { ca: this.proxy.caCert } }
            : {};

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    ...browserHeaders(productId),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
                ...proxyOpts,
            } as RequestInit);
            clearTimeout(timeoutId);

            if (!res.ok) {
                L.warn(`Sales ${productId} HTTP ${res.status}`);
                return [];
            }

            const json = (await res.json()) as Record<string, unknown>;
            const salesData = (json.data || []) as Array<Record<string, unknown>>;

            const sales: Sale[] = salesData.map((item, idx) => {
                let formattedDate = String(item.orderDate || "Unknown");
                try {
                    const dt = new Date(formattedDate);
                    formattedDate = dt.toISOString().slice(0, 16).replace("T", " ");
                } catch { /* keep raw */ }

                return {
                    sale_id: `sale-${productId}-${idx}`,
                    condition: String(item.condition || "Near Mint"),
                    variant: String(item.variant || ""),
                    price: Number(item.purchasePrice || 0),
                    shipping_price: Number(item.shippingPrice || 0),
                    quantity: Number(item.quantity || 1),
                    order_date: formattedDate,
                    language: String(item.language || "English"),
                    listing_type: String(item.listingType || ""),
                };
            });

            db().cacheSet("sales", `sales_${productId}`, sales, this.cacheTtl.sales);
            return sales;
        } catch (err) {
            clearTimeout(timeoutId);
            L.warn(`Sales ${productId} failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    // ── Price history ────────────────────────────────────────────────────────

    private static readonly CONDITION_PRIORITY = [
        "Near Mint",
        "Lightly Played",
        "Moderately Played",
        "Heavily Played",
        "Damaged",
    ];

    /**
     * Get price history. Same cache strategy as getListings.
     */
    async getHistory(
        productId: number,
        rangeType: "month" | "annual" = "month",
        forceRefresh = false,
    ): Promise<PriceHistory | null> {
        const cacheKey = `history_${productId}_${rangeType}`;

        if (!forceRefresh) {
            const fresh = db().cacheGet<PriceHistory>("history", cacheKey);
            if (fresh) return fresh;

            const stale = db().cacheGetRaw<PriceHistory>("history", cacheKey);
            if (stale) {
                this._fetchHistory(productId, rangeType).catch(e =>
                    L.debug(`Background history refresh failed for ${productId}: ${e instanceof Error ? e.message : e}`)
                );
                return stale;
            }
        }

        return this._fetchHistory(productId, rangeType);
    }

    private async _fetchHistory(productId: number, rangeType: "month" | "annual"): Promise<PriceHistory | null> {
        const url = `${this.historyBase}/${productId}/detailed?range=${rangeType}`;

        const proxyOpts: Record<string, unknown> = this.proxy
            ? { proxy: this.proxy.url, tls: { ca: this.proxy.caCert } }
            : {};

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: "GET",
                headers: browserHeaders(productId),
                signal: controller.signal,
                ...proxyOpts,
            } as RequestInit);
            clearTimeout(timeoutId);

            if (!res.ok) {
                L.warn(`History ${productId} HTTP ${res.status}`);
                return null;
            }

            const json = (await res.json()) as Record<string, unknown>;
            const results = (json.result || []) as Array<Record<string, unknown>>;

            // Parse all SKUs
            const skus: SkuHistory[] = results.map((skuData) => {
                const bucketsData = (skuData.buckets || []) as Array<Record<string, unknown>>;
                const buckets: PriceHistoryBucket[] = bucketsData.map((b) => {
                    // API returns "0" as string when no sales, treat as null
                    const lowPrice = b.lowSalePrice && Number(b.lowSalePrice) > 0 ? Number(b.lowSalePrice) : null;
                    const highPrice = b.highSalePrice && Number(b.highSalePrice) > 0 ? Number(b.highSalePrice) : null;
                    return {
                        bucket_start_date: String(b.bucketStartDate || ""),
                        market_price: Number(b.marketPrice || 0),
                        quantity_sold: Number(b.quantitySold || 0),
                        transaction_count: Number(b.transactionCount || 0),
                        low_sale_price: lowPrice,
                        high_sale_price: highPrice,
                    };
                });

                return {
                    sku_id: String(skuData.skuId || ""),
                    condition: String(skuData.condition || ""),
                    variant: String(skuData.variant || ""),
                    language: String(skuData.language || "English"),
                    total_quantity_sold: Number(skuData.totalQuantitySold || 0),
                    total_transaction_count: Number(skuData.totalTransactionCount || 0),
                    average_daily_quantity_sold: Number(skuData.averageDailyQuantitySold || 0),
                    buckets,
                };
            });

            // Select best SKU: prefer Near Mint, then fallback through condition priority
            let selectedSku: SkuHistory | null = null;

            for (const cond of TCGPlayerClient.CONDITION_PRIORITY) {
                for (const sku of skus) {
                    if (sku.condition === cond) {
                        selectedSku = sku;
                        break;
                    }
                }
                if (selectedSku) break;
            }

            // Last resort: first SKU
            if (!selectedSku && skus.length > 0) {
                selectedSku = skus[0];
            }

            // Flatten selected SKU's buckets into dates[], prices[], lows[], highs[] for OHLC charting
            const dates: string[] = [];
            const prices: number[] = [];
            const lows: (number | null)[] = [];
            const highs: (number | null)[] = [];
            if (selectedSku) {
                const sorted = [...selectedSku.buckets].sort(
                    (a, b) => new Date(a.bucket_start_date).getTime() - new Date(b.bucket_start_date).getTime(),
                );
                for (const bucket of sorted) {
                    dates.push(bucket.bucket_start_date);
                    prices.push(bucket.market_price);
                    lows.push(bucket.low_sale_price);
                    highs.push(bucket.high_sale_price);
                }
            }

            const history: PriceHistory = {
                product_id: productId,
                range_type: rangeType,
                skus,
                dates,
                prices,
                lows,
                highs,
            };

            db().cacheSet("history", `history_${productId}_${rangeType}`, history, this.cacheTtl.history);
            return history;
        } catch (err) {
            clearTimeout(timeoutId);
            L.warn(`History ${productId} failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    /** Raw cache access for history (returns stale data). */
    getCachedHistoryRaw(productId: number, rangeType: "month" | "annual" = "month"): PriceHistory | null {
        return db().cacheGetRaw<PriceHistory>("history", `history_${productId}_${rangeType}`);
    }

    // ── Bulk parallel pricing ────────────────────────────────────────────────

    /**
     * Fire ALL pricing requests simultaneously via Promise.all.
     * No queue, no rate limiting — relies on proxy for IP rotation.
     * Retries failed IDs once.
     */
    async fetchAllPricingParallel(
        ids: number[],
        maxRetries = 1,
        onProgress?: (done: number, total: number) => void,
    ): Promise<{ results: Map<number, ProductPricing>; fetched: number; failed: number; duration: number }> {
        const start = Date.now();
        const total = ids.length;
        let done = 0;

        const proxyOpts: Record<string, unknown> = this.proxy
            ? { proxy: this.proxy.url, tls: { ca: this.proxy.caCert } }
            : {};

        const fetchOne = async (productId: number): Promise<ProductPricing | null> => {
            const url = `${this.detailsBase}/${productId}/details`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            try {
                const response = await fetch(url, {
                    method: "GET",
                    headers: browserHeaders(productId),
                    signal: controller.signal,
                    ...proxyOpts,
                } as RequestInit);
                clearTimeout(timeoutId);

                if (!response.ok) {
                    L.warn(`Pricing ${productId} HTTP ${response.status} ${response.statusText}`);
                    return null;
                }

                const json = (await response.json()) as Record<string, unknown>;

                const pricing: ProductPricing = {
                    product_id: productId,
                    market_price: json.marketPrice ? Number(json.marketPrice) : null,
                    lowest_price: json.lowestPrice ? Number(json.lowestPrice) : null,
                    lowest_price_with_shipping: json.lowestPriceWithShipping
                        ? Number(json.lowestPriceWithShipping)
                        : null,
                    median_price: json.medianPrice ? Number(json.medianPrice) : null,
                    listings: Number(json.listings || 0),
                    sellers: Number(json.sellers || 0),
                    fetched_at: new Date().toISOString(),
                };

                // Cache pricing in structured table
                db().upsertPricing(pricing);

                // Cache product info in structured table
                db().upsertProduct({
                    product_id: Number(json.productId || productId),
                    product_name: String(json.productName || ""),
                    set_name: String(json.setName || ""),
                    set_code: String(json.setCode || ""),
                    rarity_name: String(json.rarityName || ""),
                    product_type_name: String(json.productTypeName || ""),
                    product_line_name: String(json.productLineName || ""),
                    image_url: `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_400w.jpg`,
                    url: `https://www.tcgplayer.com/product/${productId}`,
                    skus: (json.skus || []) as unknown[],
                });

                return pricing;
            } catch (err) {
                clearTimeout(timeoutId);
                L.warn(`Pricing ${productId} error: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        };

        // Fire with concurrency limit (default: 20 concurrent requests)
        const sem = new Semaphore(env().rateLimit.hot.maxConcurrent * 4 || 20);
        onProgress?.(0, total);
        const initialResults = await Promise.all(
            ids.map(async (pid) => {
                await sem.acquire();
                try {
                    const pricing = await fetchOne(pid);
                    done++;
                    onProgress?.(done, total);
                    return { pid, pricing };
                } finally {
                    sem.release();
                }
            }),
        );

        const results = new Map<number, ProductPricing>();
        let failedIds: number[] = [];
        for (const { pid, pricing } of initialResults) {
            if (pricing) {
                results.set(pid, pricing);
            } else {
                failedIds.push(pid);
            }
        }

        // Retry failures
        for (let attempt = 0; attempt < maxRetries && failedIds.length > 0; attempt++) {
            L.info(`Retrying ${failedIds.length} failed IDs (attempt ${attempt + 1}/${maxRetries})`);
            const retryResults = await Promise.all(
                failedIds.map(async (pid) => ({
                    pid,
                    pricing: await fetchOne(pid),
                })),
            );

            const stillFailed: number[] = [];
            for (const { pid, pricing } of retryResults) {
                if (pricing) {
                    results.set(pid, pricing);
                } else {
                    stillFailed.push(pid);
                }
            }
            failedIds = stillFailed;
        }

        const duration = Date.now() - start;
        return { results, fetched: results.size, failed: failedIds.length, duration };
    }

    // ── Seed product info from TCGCSV ────────────────────────────────────────

    /** Bulk-write ProductInfo from TCGCSV data. Skips IDs that already exist. Returns count written. */
    async seedProductInfo(batch: ProductInfo[]): Promise<number> {
        // Filter to only products not yet in DB
        const toWrite = batch.filter(info => !db().productExists(info.product_id));
        if (toWrite.length === 0) return 0;
        return db().upsertProductBatch(toWrite.map(info => ({
            product_id: info.product_id,
            product_name: info.product_name,
            set_name: info.set_name,
            set_code: info.set_code,
            rarity_name: info.rarity_name,
            product_type_name: info.product_type_name,
            product_line_name: info.product_line_name,
            image_url: info.image_url,
            url: info.url,
            skus: info.skus as unknown[],
        })));
    }

    // ── Raw cache access (for oracle — returns stale data) ───────────────────

    getCachedPricingRaw(productId: number): ProductPricing | null {
        return db().getPricing(productId);
    }

    getCachedProductInfoRaw(productId: number): ProductInfo | null {
        const row = db().getProduct(productId);
        if (!row) return null;
        return {
            product_id: row.product_id,
            product_name: row.product_name,
            set_name: row.set_name,
            set_code: row.set_code,
            rarity_name: row.rarity_name,
            product_type_name: row.product_type_name,
            product_line_name: row.product_line_name,
            image_url: row.image_url,
            url: row.url,
            skus: row.skus as Record<string, unknown>[],
        };
    }

    getCachedSalesRaw(productId: number): Sale[] | null {
        return db().cacheGetRaw<Sale[]>("sales", `sales_${productId}`);
    }

    getCachedListingsRaw(productId: number): Listing[] | null {
        return db().cacheGetRaw<Listing[]>("listings", `listings_${productId}`);
    }

    // ── Batch cache access (for bulk operations) ─────────────────────────────

    /** Batch get products - returns Map<productId, ProductInfo> */
    getCachedProductsBatch(productIds: number[]): Map<number, ProductInfo> {
        const rows = db().getProductsBatch(productIds);
        const result = new Map<number, ProductInfo>();
        for (const [id, row] of rows) {
            result.set(id, {
                product_id: row.product_id,
                product_name: row.product_name,
                set_name: row.set_name,
                set_code: row.set_code,
                rarity_name: row.rarity_name,
                product_type_name: row.product_type_name,
                product_line_name: row.product_line_name,
                image_url: row.image_url,
                url: row.url,
                skus: row.skus as Record<string, unknown>[],
            });
        }
        return result;
    }

    /** Batch get pricings - returns Map<productId, ProductPricing> */
    getCachedPricingsBatch(productIds: number[]): Map<number, ProductPricing> {
        return db().getPricingBatch(productIds);
    }

    /** Batch get history - returns Map<productId, PriceHistory> */
    getCachedHistoryBatch(productIds: number[], rangeType: "month" | "annual" = "month"): Map<number, PriceHistory> {
        const keys = productIds.map(id => `history_${id}_${rangeType}`);
        const cached = db().cacheGetRawBatch<PriceHistory>("history", keys);
        const result = new Map<number, PriceHistory>();
        for (const id of productIds) {
            const key = `history_${id}_${rangeType}`;
            const value = cached.get(key);
            if (value) result.set(id, value);
        }
        return result;
    }

    // ── Proxy test ───────────────────────────────────────────────────────────

    async testProxy(): Promise<{ ip: string; country: string } | null> {
        if (!this.proxy) return null;
        try {
            const res = await fetch("https://lumtest.com/myip.json", {
                proxy: this.proxy.url,
                tls: { ca: this.proxy.caCert },
            } as RequestInit);
            if (!res.ok) return null;
            const data = (await res.json()) as { ip: string; country: string };
            return { ip: data.ip, country: data.country };
        } catch {
            return null;
        }
    }

    /** Whether the proxy is active for outbound requests. */
    get isProxyEnabled(): boolean { return this.proxy !== null; }

    // ── Cache stats ──────────────────────────────────────────────────────────

    getCacheStats(): Record<string, { size: number; namespace: string }> {
        return {
            pricing: { size: db().getPricingCount(), namespace: "pricing" },
            product_info: { size: db().getProductCount(), namespace: "products" },
            listings: { size: db().cacheSize("listings"), namespace: "listings" },
            sales: { size: db().cacheSize("sales"), namespace: "sales" },
            history: { size: db().cacheSize("history"), namespace: "history" },
        };
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    /** Deduplicated background refresh — prevents duplicate in-flight fetches for the same product. */
    private backgroundRefreshPricing(productId: number): void {
        if (this.inflightPricing.has(productId)) return; // already in flight
        const p = this.fetchOnePricing(productId)
            .catch(e => {
                L.debug(`Background pricing refresh failed for ${productId}: ${e instanceof Error ? e.message : e}`);
                return null;
            })
            .finally(() => { this.inflightPricing.delete(productId); });
        this.inflightPricing.set(productId, p);
    }

    private async fetchOnePricing(productId: number): Promise<ProductPricing | null> {
        const result = await this.fetchAllPricingParallel([productId], 1);
        return result.results.get(productId) ?? null;
    }
}

// ── Singleton (async init pattern) ──────────────────────────────────────────

let _instance: TCGPlayerClient | null = null;

export async function initTcgplayer(): Promise<TCGPlayerClient> {
    if (_instance) return _instance;
    _instance = new TCGPlayerClient();
    await _instance.init();
    return _instance;
}

export function tcgplayer(): TCGPlayerClient {
    if (!_instance) throw new Error("TCGPlayerClient not initialized — call initTcgplayer() first");
    return _instance;
}
