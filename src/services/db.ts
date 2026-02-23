/**
 * CardDatabase — SQLite-backed storage for all Pokemon card data.
 *
 * Replaces the file-based PersistentCache with a single SQLite database
 * providing indexed queries, efficient storage, and atomic operations.
 *
 * Tables:
 *   - cache            Generic key-value cache (replaces PersistentCache)
 *   - products         Static product info (name, set, rarity, image)
 *   - pricing          Live pricing snapshots (market_price, listings, sellers)
 *   - analysis         Card analysis results (scores, metrics)
 *   - keeper_feeds     Oracle keeper feed state (PDA, delegated, last price)
 *
 * Uses Bun's built-in bun:sqlite for zero-dependency, high-performance SQLite.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { log } from "../log";

const L = log("db");

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Generic key-value cache with TTL (replaces all PersistentCache instances)
CREATE TABLE IF NOT EXISTS cache (
    namespace   TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,  -- JSON-encoded
    created_at  INTEGER NOT NULL,  -- unix ms
    expires_at  INTEGER NOT NULL,  -- unix ms
    ttl_seconds INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(namespace, expires_at);

-- Static product info (rarely changes — 30-day TTL)
CREATE TABLE IF NOT EXISTS products (
    product_id          INTEGER PRIMARY KEY,
    product_name        TEXT    NOT NULL DEFAULT '',
    set_name            TEXT    NOT NULL DEFAULT '',
    set_code            TEXT    NOT NULL DEFAULT '',
    rarity_name         TEXT    NOT NULL DEFAULT '',
    product_type_name   TEXT    NOT NULL DEFAULT 'Cards',
    product_line_name   TEXT    NOT NULL DEFAULT 'Pokemon',
    image_url           TEXT    NOT NULL DEFAULT '',
    url                 TEXT    NOT NULL DEFAULT '',
    skus                TEXT    NOT NULL DEFAULT '[]',  -- JSON array
    updated_at          INTEGER NOT NULL DEFAULT 0      -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(product_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_set ON products(set_name);

-- Live pricing snapshots (changes every few minutes)
CREATE TABLE IF NOT EXISTS pricing (
    product_id                  INTEGER PRIMARY KEY,
    market_price                REAL,
    lowest_price                REAL,
    lowest_price_with_shipping  REAL,
    median_price                REAL,
    listings                    INTEGER NOT NULL DEFAULT 0,
    sellers                     INTEGER NOT NULL DEFAULT 0,
    fetched_at                  TEXT    NOT NULL DEFAULT '',  -- ISO string
    updated_at                  INTEGER NOT NULL DEFAULT 0   -- unix ms
);

-- Card analysis results (scored cards with full metrics)
CREATE TABLE IF NOT EXISTS analysis (
    product_id          INTEGER PRIMARY KEY,
    product_name        TEXT    NOT NULL DEFAULT '',
    category            INTEGER NOT NULL DEFAULT 0,
    grp                 TEXT    NOT NULL DEFAULT '',  -- "group" is reserved
    sub_type            TEXT    NOT NULL DEFAULT '',
    date_range_start    TEXT    NOT NULL DEFAULT '',
    date_range_end      TEXT    NOT NULL DEFAULT '',
    total_days          INTEGER NOT NULL DEFAULT 0,
    activity_score      REAL    NOT NULL DEFAULT 0,
    change_24h          REAL    NOT NULL DEFAULT 0,
    change_30d          REAL    NOT NULL DEFAULT 0,
    current_price       REAL    NOT NULL DEFAULT 0,
    min_price           REAL    NOT NULL DEFAULT 0,
    max_price           REAL    NOT NULL DEFAULT 0,
    mean_price          REAL    NOT NULL DEFAULT 0,
    metrics             TEXT,  -- JSON-encoded PerpMetrics (nullable if no metrics)
    updated_at          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_analysis_score ON analysis(activity_score DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_name ON analysis(product_name COLLATE NOCASE);

-- Analysis metadata (singleton row)
CREATE TABLE IF NOT EXISTS analysis_metadata (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    generated_at            TEXT    NOT NULL DEFAULT '',
    total_cards_analyzed    INTEGER NOT NULL DEFAULT 0,
    categories              TEXT    NOT NULL DEFAULT '[]',  -- JSON array
    rolling_window_days     INTEGER NOT NULL DEFAULT 0,
    most_active_card        TEXT,
    avg_activity_score      REAL    NOT NULL DEFAULT 0,
    median_activity_score   REAL    NOT NULL DEFAULT 0,
    high_activity_count     INTEGER NOT NULL DEFAULT 0
);

-- Oracle keeper feed state
CREATE TABLE IF NOT EXISTS keeper_feeds (
    product_id          INTEGER PRIMARY KEY,
    pda                 TEXT    NOT NULL DEFAULT '',
    created             INTEGER NOT NULL DEFAULT 0,  -- boolean
    delegated           INTEGER NOT NULL DEFAULT 0,  -- boolean
    last_published_price REAL   NOT NULL DEFAULT 0,
    last_published_at   INTEGER NOT NULL DEFAULT 0,  -- unix ms
    updated_at          INTEGER NOT NULL DEFAULT 0
);

-- Activation requests (users requesting a product be activated for trading)
CREATE TABLE IF NOT EXISTS activation_requests (
    product_id      INTEGER NOT NULL,
    wallet          TEXT    NOT NULL,
    product_name    TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    created_at      INTEGER NOT NULL DEFAULT 0,          -- unix ms
    resolved_at     INTEGER,                             -- unix ms (null if pending)
    PRIMARY KEY (product_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_activation_requests_status ON activation_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activation_requests_product ON activation_requests(product_id, created_at DESC);

-- TCGCSV product catalog (bulk product data)
CREATE TABLE IF NOT EXISTS tcgcsv_products (
    product_id      INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL DEFAULT '',
    clean_name      TEXT    NOT NULL DEFAULT '',
    image_url       TEXT    NOT NULL DEFAULT '',
    category_id     INTEGER NOT NULL DEFAULT 0,
    group_id        INTEGER NOT NULL DEFAULT 0,
    url             TEXT    NOT NULL DEFAULT '',
    extended_data   TEXT    NOT NULL DEFAULT '[]',  -- JSON array
    group_name      TEXT    NOT NULL DEFAULT '',
    group_abbr      TEXT    NOT NULL DEFAULT '',
    updated_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tcgcsv_group ON tcgcsv_products(group_id);
CREATE INDEX IF NOT EXISTS idx_tcgcsv_category ON tcgcsv_products(category_id);
CREATE INDEX IF NOT EXISTS idx_tcgcsv_name ON tcgcsv_products(name COLLATE NOCASE);

-- Referral codes (one per wallet)
CREATE TABLE IF NOT EXISTS referral_codes (
    wallet      TEXT    PRIMARY KEY,
    code        TEXT    NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL DEFAULT 0  -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);

-- Referral signups (who referred whom)
CREATE TABLE IF NOT EXISTS referral_signups (
    referred_wallet     TEXT    PRIMARY KEY,  -- the person who was referred
    referrer_wallet     TEXT    NOT NULL,      -- the person who referred them
    referrer_code       TEXT    NOT NULL,
    points              INTEGER NOT NULL DEFAULT 100,  -- points awarded for this signup
    created_at          INTEGER NOT NULL DEFAULT 0     -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_referral_signups_referrer ON referral_signups(referrer_wallet);
`;

// ── Database wrapper ────────────────────────────────────────────────────────

export class CardDatabase {
    private db: Database;
    private _closed = false;

    constructor(dbPath: string) {
        // Ensure parent directory exists
        const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
        if (dir) mkdirSync(dir, { recursive: true });

        this.db = new Database(dbPath);

        // Performance tuning for WAL mode
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec("PRAGMA busy_timeout = 5000");    // wait up to 5s on lock
        this.db.exec("PRAGMA cache_size = -64000");    // 64MB cache
        this.db.exec("PRAGMA temp_store = MEMORY");
        this.db.exec("PRAGMA mmap_size = 268435456");  // 256MB mmap

        // Create tables & indexes
        this.db.exec(SCHEMA_SQL);

        L.info(`Database opened: ${dbPath}`);
    }

    // ── Generic cache operations (replaces PersistentCache) ─────────────────

    cacheGet<T>(namespace: string, key: string): T | null {
        const row = this.db.query<{ value: string; expires_at: number }, [string, string]>(
            "SELECT value, expires_at FROM cache WHERE namespace = ? AND key = ?",
        ).get(namespace, key);

        if (!row) return null;
        if (Date.now() > row.expires_at) {
            // Expired — delete and return null
            this.db.run("DELETE FROM cache WHERE namespace = ? AND key = ?", [namespace, key]);
            return null;
        }
        try { return JSON.parse(row.value) as T; }
        catch { return null; }
    }

    /** Get value ignoring TTL (stale-while-revalidate). Null only if missing. */
    cacheGetRaw<T>(namespace: string, key: string): T | null {
        const row = this.db.query<{ value: string }, [string, string]>(
            "SELECT value FROM cache WHERE namespace = ? AND key = ?",
        ).get(namespace, key);

        if (!row) return null;
        try { return JSON.parse(row.value) as T; }
        catch { return null; }
    }

    /** Batch get multiple cache values by keys - returns a Map */
    cacheGetRawBatch<T>(namespace: string, keys: string[]): Map<string, T> {
        if (keys.length === 0) return new Map();
        const placeholders = keys.map(() => "?").join(",");
        const rows = this.db.query<{ key: string; value: string }, string[]>(
            `SELECT key, value FROM cache WHERE namespace = ? AND key IN (${placeholders})`,
        ).all(namespace, ...keys);

        const result = new Map<string, T>();
        for (const row of rows) {
            try { result.set(row.key, JSON.parse(row.value) as T); }
            catch { /* skip invalid */ }
        }
        return result;
    }

    /** Get value + age in seconds. Null if expired or missing. */
    cacheGetWithAge<T>(namespace: string, key: string): { value: T; ageSeconds: number } | null {
        const row = this.db.query<{ value: string; created_at: number; expires_at: number }, [string, string]>(
            "SELECT value, created_at, expires_at FROM cache WHERE namespace = ? AND key = ?",
        ).get(namespace, key);

        if (!row) return null;
        if (Date.now() > row.expires_at) {
            this.db.run("DELETE FROM cache WHERE namespace = ? AND key = ?", [namespace, key]);
            return null;
        }
        try {
            return {
                value: JSON.parse(row.value) as T,
                ageSeconds: (Date.now() - row.created_at) / 1000,
            };
        } catch { return null; }
    }

    cacheSet(namespace: string, key: string, value: unknown, ttlSeconds: number): void {
        const now = Date.now();
        const json = JSON.stringify(value);
        this.db.run(
            `INSERT OR REPLACE INTO cache (namespace, key, value, created_at, expires_at, ttl_seconds)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [namespace, key, json, now, now + ttlSeconds * 1000, ttlSeconds],
        );
    }

    cacheDelete(namespace: string, key: string): boolean {
        const result = this.db.run(
            "DELETE FROM cache WHERE namespace = ? AND key = ?",
            [namespace, key],
        );
        return result.changes > 0;
    }

    cacheClear(namespace: string): number {
        const result = this.db.run("DELETE FROM cache WHERE namespace = ?", [namespace]);
        return result.changes;
    }

    cacheContains(namespace: string, key: string): boolean {
        const row = this.db.query<{ c: number }, [string, string]>(
            "SELECT 1 as c FROM cache WHERE namespace = ? AND key = ?",
        ).get(namespace, key);
        return row !== null;
    }

    cacheSize(namespace: string): number {
        const row = this.db.query<{ cnt: number }, [string]>(
            "SELECT COUNT(*) as cnt FROM cache WHERE namespace = ?",
        ).get(namespace);
        return row?.cnt ?? 0;
    }

    /** Remove expired entries from a namespace. Returns count deleted. */
    cacheCleanup(namespace: string): number {
        const result = this.db.run(
            "DELETE FROM cache WHERE namespace = ? AND expires_at < ?",
            [namespace, Date.now()],
        );
        return result.changes;
    }

    // ── Product info (structured table) ─────────────────────────────────────

    upsertProduct(p: {
        product_id: number;
        product_name: string;
        set_name: string;
        set_code: string;
        rarity_name: string;
        product_type_name: string;
        product_line_name: string;
        image_url: string;
        url: string;
        skus: unknown[];
    }): void {
        this.db.run(
            `INSERT OR REPLACE INTO products
                (product_id, product_name, set_name, set_code, rarity_name,
                 product_type_name, product_line_name, image_url, url, skus, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.product_id, p.product_name, p.set_name, p.set_code, p.rarity_name,
             p.product_type_name, p.product_line_name, p.image_url, p.url,
             JSON.stringify(p.skus), Date.now()],
        );
    }

    upsertProductBatch(products: Array<{
        product_id: number;
        product_name: string;
        set_name: string;
        set_code: string;
        rarity_name: string;
        product_type_name: string;
        product_line_name: string;
        image_url: string;
        url: string;
        skus: unknown[];
    }>): number {
        const stmt = this.db.prepare(
            `INSERT OR REPLACE INTO products
                (product_id, product_name, set_name, set_code, rarity_name,
                 product_type_name, product_line_name, image_url, url, skus, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const now = Date.now();
        const tx = this.db.transaction(() => {
            let count = 0;
            for (const p of products) {
                stmt.run(
                    p.product_id, p.product_name, p.set_name, p.set_code, p.rarity_name,
                    p.product_type_name, p.product_line_name, p.image_url, p.url,
                    JSON.stringify(p.skus), now,
                );
                count++;
            }
            return count;
        });
        return tx();
    }

    getProduct(productId: number): {
        product_id: number; product_name: string; set_name: string; set_code: string;
        rarity_name: string; product_type_name: string; product_line_name: string;
        image_url: string; url: string; skus: unknown[];
    } | null {
        const row = this.db.query<{
            product_id: number; product_name: string; set_name: string; set_code: string;
            rarity_name: string; product_type_name: string; product_line_name: string;
            image_url: string; url: string; skus: string;
        }, [number]>(
            "SELECT * FROM products WHERE product_id = ?",
        ).get(productId);

        if (!row) return null;
        return { ...row, skus: JSON.parse(row.skus) };
    }

    productExists(productId: number): boolean {
        const row = this.db.query<{ c: number }, [number]>(
            "SELECT 1 as c FROM products WHERE product_id = ?",
        ).get(productId);
        return row !== null;
    }

    getProductCount(): number {
        const row = this.db.query<{ cnt: number }, []>(
            "SELECT COUNT(*) as cnt FROM products",
        ).get();
        return row?.cnt ?? 0;
    }

    /** Batch get multiple products by IDs - returns a Map for O(1) lookup */
    getProductsBatch(productIds: number[]): Map<number, {
        product_id: number; product_name: string; set_name: string; set_code: string;
        rarity_name: string; product_type_name: string; product_line_name: string;
        image_url: string; url: string; skus: unknown[];
    }> {
        if (productIds.length === 0) return new Map();
        const placeholders = productIds.map(() => "?").join(",");
        const rows = this.db.query<{
            product_id: number; product_name: string; set_name: string; set_code: string;
            rarity_name: string; product_type_name: string; product_line_name: string;
            image_url: string; url: string; skus: string;
        }, number[]>(
            `SELECT * FROM products WHERE product_id IN (${placeholders})`,
        ).all(...productIds);

        const result = new Map<number, any>();
        for (const row of rows) {
            result.set(row.product_id, { ...row, skus: JSON.parse(row.skus) });
        }
        return result;
    }

    // ── Pricing (structured table) ──────────────────────────────────────────

    upsertPricing(p: {
        product_id: number;
        market_price: number | null;
        lowest_price: number | null;
        lowest_price_with_shipping: number | null;
        median_price: number | null;
        listings: number;
        sellers: number;
        fetched_at: string;
    }): void {
        this.db.run(
            `INSERT OR REPLACE INTO pricing
                (product_id, market_price, lowest_price, lowest_price_with_shipping,
                 median_price, listings, sellers, fetched_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.product_id, p.market_price, p.lowest_price, p.lowest_price_with_shipping,
             p.median_price, p.listings, p.sellers, p.fetched_at, Date.now()],
        );
    }

    getPricing(productId: number): {
        product_id: number; market_price: number | null; lowest_price: number | null;
        lowest_price_with_shipping: number | null; median_price: number | null;
        listings: number; sellers: number; fetched_at: string;
    } | null {
        return this.db.query<{
            product_id: number; market_price: number | null; lowest_price: number | null;
            lowest_price_with_shipping: number | null; median_price: number | null;
            listings: number; sellers: number; fetched_at: string;
        }, [number]>(
            `SELECT product_id, market_price, lowest_price, lowest_price_with_shipping,
                    median_price, listings, sellers, fetched_at
             FROM pricing WHERE product_id = ?`,
        ).get(productId);
    }

    getPricingAge(productId: number): number | null {
        const row = this.db.query<{ updated_at: number }, [number]>(
            "SELECT updated_at FROM pricing WHERE product_id = ?",
        ).get(productId);
        if (!row) return null;
        return (Date.now() - row.updated_at) / 1000;
    }

    /** Batch get multiple pricings by IDs - returns a Map for O(1) lookup */
    getPricingBatch(productIds: number[]): Map<number, {
        product_id: number; market_price: number | null; lowest_price: number | null;
        lowest_price_with_shipping: number | null; median_price: number | null;
        listings: number; sellers: number; fetched_at: string;
    }> {
        if (productIds.length === 0) return new Map();
        const placeholders = productIds.map(() => "?").join(",");
        const rows = this.db.query<{
            product_id: number; market_price: number | null; lowest_price: number | null;
            lowest_price_with_shipping: number | null; median_price: number | null;
            listings: number; sellers: number; fetched_at: string;
        }, number[]>(
            `SELECT product_id, market_price, lowest_price, lowest_price_with_shipping,
                    median_price, listings, sellers, fetched_at
             FROM pricing WHERE product_id IN (${placeholders})`,
        ).all(...productIds);

        const result = new Map<number, any>();
        for (const row of rows) {
            result.set(row.product_id, row);
        }
        return result;
    }

    getPricingCount(): number {
        const row = this.db.query<{ cnt: number }, []>(
            "SELECT COUNT(*) as cnt FROM pricing",
        ).get();
        return row?.cnt ?? 0;
    }

    // ── Analysis (structured table with indexed scores) ─────────────────────

    upsertAnalysisBatch(cards: Array<{
        product_id: number; product_name: string; category: number;
        group: string; sub_type: string; date_range_start: string;
        date_range_end: string; total_days: number; activity_score: number;
        change_24h: number; change_30d: number; current_price: number;
        min_price: number; max_price: number; mean_price: number;
        activity: unknown | null;
    }>): number {
        const stmt = this.db.prepare(
            `INSERT OR REPLACE INTO analysis
                (product_id, product_name, category, grp, sub_type,
                 date_range_start, date_range_end, total_days, activity_score,
                 change_24h, change_30d, current_price, min_price, max_price,
                 mean_price, metrics, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const now = Date.now();
        const tx = this.db.transaction(() => {
            let count = 0;
            for (const c of cards) {
                stmt.run(
                    c.product_id, c.product_name, c.category, c.group, c.sub_type,
                    c.date_range_start, c.date_range_end, c.total_days, c.activity_score,
                    c.change_24h, c.change_30d, c.current_price, c.min_price, c.max_price,
                    c.mean_price, c.activity ? JSON.stringify(c.activity) : null, now,
                );
                count++;
            }
            return count;
        });
        return tx();
    }

    upsertAnalysisMetadata(meta: {
        generated_at: string; total_cards_analyzed: number; categories: number[];
        rolling_window_days: number; most_active_card: string | null;
        avg_activity_score: number; median_activity_score: number;
        high_activity_count: number;
    }): void {
        this.db.run(
            `INSERT OR REPLACE INTO analysis_metadata
                (id, generated_at, total_cards_analyzed, categories, rolling_window_days,
                 most_active_card, avg_activity_score, median_activity_score, high_activity_count)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [meta.generated_at, meta.total_cards_analyzed, JSON.stringify(meta.categories),
             meta.rolling_window_days, meta.most_active_card, meta.avg_activity_score,
             meta.median_activity_score, meta.high_activity_count],
        );
    }

    getAnalysisMetadata(): {
        generated_at: string; total_cards_analyzed: number; categories: number[];
        rolling_window_days: number; most_active_card: string | null;
        avg_activity_score: number; median_activity_score: number;
        high_activity_count: number;
    } | null {
        const row = this.db.query<{
            generated_at: string; total_cards_analyzed: number; categories: string;
            rolling_window_days: number; most_active_card: string | null;
            avg_activity_score: number; median_activity_score: number;
            high_activity_count: number;
        }, []>(
            "SELECT * FROM analysis_metadata WHERE id = 1",
        ).get();
        if (!row) return null;
        return { ...row, categories: JSON.parse(row.categories) };
    }

    /** Get top N cards by activity score (uses index). */
    getTopAnalysis(limit: number): Array<{
        product_id: number; product_name: string; category: number;
        group: string; sub_type: string; activity_score: number;
        change_24h: number; change_30d: number; current_price: number;
        min_price: number; max_price: number; mean_price: number;
    }> {
        return this.db.query<{
            product_id: number; product_name: string; category: number;
            grp: string; sub_type: string; activity_score: number;
            change_24h: number; change_30d: number; current_price: number;
            min_price: number; max_price: number; mean_price: number;
        }, [number]>(
            `SELECT product_id, product_name, category, grp, sub_type,
                    activity_score, change_24h, change_30d, current_price,
                    min_price, max_price, mean_price
             FROM analysis ORDER BY activity_score DESC, product_id ASC LIMIT ?`,
        ).all(limit).map(r => ({ ...r, group: r.grp }));
    }

    /** Get a single card's analysis with full metrics. */
    getAnalysis(productId: number): {
        product_id: number; product_name: string; category: number;
        group: string; sub_type: string; date_range_start: string;
        date_range_end: string; total_days: number; activity_score: number;
        change_24h: number; change_30d: number; current_price: number;
        min_price: number; max_price: number; mean_price: number;
        activity: unknown | null;
    } | null {
        const row = this.db.query<{
            product_id: number; product_name: string; category: number;
            grp: string; sub_type: string; date_range_start: string;
            date_range_end: string; total_days: number; activity_score: number;
            change_24h: number; change_30d: number; current_price: number;
            min_price: number; max_price: number; mean_price: number;
            metrics: string | null;
        }, [number]>(
            `SELECT product_id, product_name, category, grp, sub_type,
                    date_range_start, date_range_end, total_days, activity_score,
                    change_24h, change_30d, current_price, min_price, max_price,
                    mean_price, metrics
             FROM analysis WHERE product_id = ?`,
        ).get(productId);
        if (!row) return null;
        return {
            ...row,
            group: row.grp,
            activity: row.metrics ? JSON.parse(row.metrics) : null,
        };
    }

    /** Get analysis for multiple product IDs (batch). */
    getAnalysisBatch(productIds: number[]): Map<number, {
        product_id: number; product_name: string; category: number;
        group: string; sub_type: string; activity_score: number;
        change_24h: number; change_30d: number; current_price: number;
        min_price: number; max_price: number; mean_price: number;
        activity: unknown | null;
    }> {
        if (productIds.length === 0) return new Map();
        // SQLite doesn't support array params; build IN clause
        const placeholders = productIds.map(() => "?").join(",");
        const rows = this.db.query<{
            product_id: number; product_name: string; category: number;
            grp: string; sub_type: string; activity_score: number;
            change_24h: number; change_30d: number; current_price: number;
            min_price: number; max_price: number; mean_price: number;
            metrics: string | null;
        }, number[]>(
            `SELECT product_id, product_name, category, grp, sub_type,
                    activity_score, change_24h, change_30d, current_price,
                    min_price, max_price, mean_price, metrics
             FROM analysis WHERE product_id IN (${placeholders})`,
        ).all(...productIds);

        const map = new Map<number, any>();
        for (const row of rows) {
            map.set(row.product_id, {
                ...row,
                group: row.grp,
                activity: row.metrics ? JSON.parse(row.metrics) : null,
            });
        }
        return map;
    }

    /** Full-text search on analysis by product name (uses LIKE for simplicity). */
    searchAnalysis(query: string, limit: number): Array<{
        product_id: number; product_name: string; category: number;
        group: string; sub_type: string; activity_score: number;
        change_24h: number; change_30d: number; current_price: number;
    }> {
        const pattern = `%${query}%`;
        return this.db.query<{
            product_id: number; product_name: string; category: number;
            grp: string; sub_type: string; activity_score: number;
            change_24h: number; change_30d: number; current_price: number;
        }, [string, string, number]>(
            `SELECT product_id, product_name, category, grp, sub_type,
                    activity_score, change_24h, change_30d, current_price
             FROM analysis
             WHERE product_name LIKE ? OR grp LIKE ?
             ORDER BY activity_score DESC, product_id ASC
             LIMIT ?`,
        ).all(pattern, pattern, limit).map(r => ({ ...r, group: r.grp }));
    }

    getAnalysisCount(): number {
        const row = this.db.query<{ cnt: number }, []>(
            "SELECT COUNT(*) as cnt FROM analysis",
        ).get();
        return row?.cnt ?? 0;
    }

    /** Get all analysis rows for a set of product IDs, in activity_score order. */
    getAnalysisForIds(productIds: Set<number>): Array<{
        product_id: number; product_name: string; category: number;
        group: string; sub_type: string; date_range_start: string;
        date_range_end: string; total_days: number; activity_score: number;
        change_24h: number; change_30d: number; current_price: number;
        min_price: number; max_price: number; mean_price: number;
        activity: unknown | null;
    }> {
        if (productIds.size === 0) return [];
        const ids = [...productIds];
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db.query<{
            product_id: number; product_name: string; category: number;
            grp: string; sub_type: string; date_range_start: string;
            date_range_end: string; total_days: number; activity_score: number;
            change_24h: number; change_30d: number; current_price: number;
            min_price: number; max_price: number; mean_price: number;
            metrics: string | null;
        }, number[]>(
            `SELECT product_id, product_name, category, grp, sub_type,
                    date_range_start, date_range_end, total_days, activity_score,
                    change_24h, change_30d, current_price, min_price, max_price,
                    mean_price, metrics
             FROM analysis WHERE product_id IN (${placeholders})
             ORDER BY activity_score DESC, product_id ASC`,
        ).all(...ids);

        return rows.map(r => ({
            ...r,
            group: r.grp,
            activity: r.metrics ? JSON.parse(r.metrics) : null,
        }));
    }

    // ── TCGCSV products (bulk catalog) ──────────────────────────────────────

    upsertTcgcsvProductBatch(products: Array<{
        productId: number; name: string; cleanName?: string;
        imageUrl?: string; categoryId?: number; groupId?: number;
        url?: string; extendedData?: unknown[];
        groupName?: string; groupAbbr?: string;
    }>): number {
        const stmt = this.db.prepare(
            `INSERT OR REPLACE INTO tcgcsv_products
                (product_id, name, clean_name, image_url, category_id, group_id,
                 url, extended_data, group_name, group_abbr, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const now = Date.now();
        const tx = this.db.transaction(() => {
            let count = 0;
            for (const p of products) {
                stmt.run(
                    p.productId, p.name, p.cleanName ?? "", p.imageUrl ?? "",
                    p.categoryId ?? 0, p.groupId ?? 0, p.url ?? "",
                    JSON.stringify(p.extendedData ?? []),
                    p.groupName ?? "", p.groupAbbr ?? "", now,
                );
                count++;
            }
            return count;
        });
        return tx();
    }

    getTcgcsvProduct(productId: number): {
        productId: number; name: string; cleanName: string;
        imageUrl: string; categoryId: number; groupId: number;
        url: string; extendedData: unknown[];
        groupName: string; groupAbbr: string;
    } | null {
        const row = this.db.query<{
            product_id: number; name: string; clean_name: string;
            image_url: string; category_id: number; group_id: number;
            url: string; extended_data: string;
            group_name: string; group_abbr: string;
        }, [number]>(
            "SELECT * FROM tcgcsv_products WHERE product_id = ?",
        ).get(productId);
        if (!row) return null;
        return {
            productId: row.product_id, name: row.name,
            cleanName: row.clean_name, imageUrl: row.image_url,
            categoryId: row.category_id, groupId: row.group_id,
            url: row.url, extendedData: JSON.parse(row.extended_data),
            groupName: row.group_name, groupAbbr: row.group_abbr,
        };
    }

    getTcgcsvProductCount(): number {
        const row = this.db.query<{ cnt: number }, []>(
            "SELECT COUNT(*) as cnt FROM tcgcsv_products",
        ).get();
        return row?.cnt ?? 0;
    }

    /** Get all product names as a Map<productId, name>. */
    getAllTcgcsvProductNames(): Map<number, string> {
        const rows = this.db.query<{ product_id: number; name: string }, []>(
            "SELECT product_id, name FROM tcgcsv_products WHERE name != ''",
        ).all();
        const map = new Map<number, string>();
        for (const r of rows) map.set(r.product_id, r.name);
        return map;
    }

    /** Load all TCGCSV products into memory. */
    getAllTcgcsvProducts(): Map<number, {
        productId: number; name: string; cleanName: string;
        imageUrl: string; categoryId: number; groupId: number;
        url: string; extendedData: unknown[];
        groupName: string; groupAbbr: string;
    }> {
        const rows = this.db.query<{
            product_id: number; name: string; clean_name: string;
            image_url: string; category_id: number; group_id: number;
            url: string; extended_data: string;
            group_name: string; group_abbr: string;
        }, []>(
            "SELECT * FROM tcgcsv_products",
        ).all();
        const map = new Map<number, any>();
        for (const row of rows) {
            map.set(row.product_id, {
                productId: row.product_id, name: row.name,
                cleanName: row.clean_name, imageUrl: row.image_url,
                categoryId: row.category_id, groupId: row.group_id,
                url: row.url, extendedData: JSON.parse(row.extended_data),
                groupName: row.group_name, groupAbbr: row.group_abbr,
            });
        }
        return map;
    }

    // ── Keeper feeds ────────────────────────────────────────────────────────

    upsertKeeperFeed(productId: number, data: {
        pda: string; created: boolean; delegated: boolean;
        lastPublishedPrice: number; lastPublishedAt: number;
    }): void {
        this.db.run(
            `INSERT OR REPLACE INTO keeper_feeds
                (product_id, pda, created, delegated, last_published_price,
                 last_published_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [productId, data.pda, data.created ? 1 : 0, data.delegated ? 1 : 0,
             data.lastPublishedPrice, data.lastPublishedAt, Date.now()],
        );
    }

    getKeeperFeed(productId: number): {
        pda: string; created: boolean; delegated: boolean;
        lastPublishedPrice: number; lastPublishedAt: number;
    } | null {
        const row = this.db.query<{
            pda: string; created: number; delegated: number;
            last_published_price: number; last_published_at: number;
        }, [number]>(
            `SELECT pda, created, delegated, last_published_price, last_published_at
             FROM keeper_feeds WHERE product_id = ?`,
        ).get(productId);
        if (!row) return null;
        return {
            pda: row.pda,
            created: row.created === 1,
            delegated: row.delegated === 1,
            lastPublishedPrice: row.last_published_price,
            lastPublishedAt: row.last_published_at,
        };
    }

    getAllKeeperFeeds(): Map<number, {
        pda: string; created: boolean; delegated: boolean;
        lastPublishedPrice: number; lastPublishedAt: number;
    }> {
        const rows = this.db.query<{
            product_id: number; pda: string; created: number;
            delegated: number; last_published_price: number;
            last_published_at: number;
        }, []>(
            "SELECT * FROM keeper_feeds",
        ).all();
        const map = new Map();
        for (const r of rows) {
            map.set(r.product_id, {
                pda: r.pda, created: r.created === 1,
                delegated: r.delegated === 1,
                lastPublishedPrice: r.last_published_price,
                lastPublishedAt: r.last_published_at,
            });
        }
        return map;
    }

    // ── Activation requests ────────────────────────────────────────────────

    /**
     * Insert an activation request. Returns false if this wallet already
     * requested this product (unique constraint on product_id + wallet).
     */
    insertActivationRequest(productId: number, wallet: string, productName: string): boolean {
        try {
            this.db.run(
                `INSERT INTO activation_requests (product_id, wallet, product_name, status, created_at)
                 VALUES (?, ?, ?, 'pending', ?)`,
                [productId, wallet, productName, Date.now()],
            );
            return true;
        } catch (e: any) {
            // UNIQUE constraint violation = already requested
            if (e.message?.includes("UNIQUE constraint")) return false;
            throw e;
        }
    }

    /** Check if a wallet already requested activation for a product. */
    hasActivationRequest(productId: number, wallet: string): { exists: boolean; status: string } {
        const row = this.db.query<{ status: string }, [number, string]>(
            "SELECT status FROM activation_requests WHERE product_id = ? AND wallet = ?",
        ).get(productId, wallet);
        if (!row) return { exists: false, status: "" };
        return { exists: true, status: row.status };
    }

    /** Get all activation requests, optionally filtered by status. Sorted newest first. */
    getActivationRequests(opts: {
        status?: string;
        limit?: number;
        offset?: number;
    } = {}): Array<{
        product_id: number; wallet: string; product_name: string;
        status: string; created_at: number; resolved_at: number | null;
        request_count: number;
    }> {
        // Aggregate: group by product_id, show unique wallet count + all wallets
        // But also return individual rows for admin detail view
        const { status, limit = 100, offset = 0 } = opts;

        if (status) {
            return this.db.query<{
                product_id: number; wallet: string; product_name: string;
                status: string; created_at: number; resolved_at: number | null;
                request_count: number;
            }, [string, number, number]>(
                `SELECT ar.*, (
                    SELECT COUNT(*) FROM activation_requests ar2
                    WHERE ar2.product_id = ar.product_id
                 ) as request_count
                 FROM activation_requests ar
                 WHERE ar.status = ?
                 ORDER BY ar.created_at DESC
                 LIMIT ? OFFSET ?`,
            ).all(status, limit, offset);
        }

        return this.db.query<{
            product_id: number; wallet: string; product_name: string;
            status: string; created_at: number; resolved_at: number | null;
            request_count: number;
        }, [number, number]>(
            `SELECT ar.*, (
                SELECT COUNT(*) FROM activation_requests ar2
                WHERE ar2.product_id = ar.product_id
             ) as request_count
             FROM activation_requests ar
             ORDER BY ar.created_at DESC
             LIMIT ? OFFSET ?`,
        ).all(limit, offset);
    }

    /** Get aggregated activation requests: one row per product with total request count. */
    getActivationRequestsSummary(opts: {
        status?: string;
        limit?: number;
        offset?: number;
    } = {}): Array<{
        product_id: number; product_name: string;
        request_count: number; first_requested_at: number; last_requested_at: number;
        wallets: string[];
    }> {
        const { status, limit = 100, offset = 0 } = opts;

        const whereClause = status ? "WHERE status = ?" : "";
        const params = status ? [status, limit, offset] : [limit, offset];

        const rows = this.db.query<{
            product_id: number; product_name: string;
            request_count: number; first_requested_at: number; last_requested_at: number;
            wallet_list: string;
        }, any[]>(
            `SELECT product_id, MAX(product_name) as product_name,
                    COUNT(*) as request_count,
                    MIN(created_at) as first_requested_at,
                    MAX(created_at) as last_requested_at,
                    GROUP_CONCAT(wallet, ',') as wallet_list
             FROM activation_requests
             ${whereClause}
             GROUP BY product_id
             ORDER BY request_count DESC, last_requested_at DESC
             LIMIT ? OFFSET ?`,
        ).all(...params);

        return rows.map(r => ({
            ...r,
            wallets: r.wallet_list ? r.wallet_list.split(",") : [],
        }));
    }

    /** Update the status of all requests for a product. */
    updateActivationRequestStatus(productId: number, status: "approved" | "rejected"): number {
        const result = this.db.run(
            `UPDATE activation_requests SET status = ?, resolved_at = ? WHERE product_id = ?`,
            [status, Date.now(), productId],
        );
        return result.changes;
    }

    /** Count pending activation requests. */
    countPendingActivationRequests(): number {
        const row = this.db.query<{ cnt: number }, []>(
            "SELECT COUNT(DISTINCT product_id) as cnt FROM activation_requests WHERE status = 'pending'",
        ).get();
        return row?.cnt ?? 0;
    }

    // ── Utility ─────────────────────────────────────────────────────────────

    /** Run VACUUM to reclaim disk space. */
    vacuum(): void {
        this.db.exec("VACUUM");
    }

    /** Get database file size info. */
    getDbStats(): { pageSizeBytes: number; pageCount: number; totalSizeBytes: number } {
        const pageSize = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 4096;
        const pageCount = this.db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
        return {
            pageSizeBytes: pageSize,
            pageCount,
            totalSizeBytes: pageSize * pageCount,
        };
    }

    /** Get row counts for all tables. */
    getTableCounts(): Record<string, number> {
        const tables = ["cache", "products", "pricing", "analysis", "keeper_feeds", "tcgcsv_products", "activation_requests", "referral_codes", "referral_signups"];
        const counts: Record<string, number> = {};
        for (const t of tables) {
            const row = this.db.query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM ${t}`).get();
            counts[t] = row?.cnt ?? 0;
        }
        return counts;
    }

    // ── Referral operations ────────────────────────────────────────────────

    /** Get or create a referral code for a wallet. Returns the code. */
    getOrCreateReferralCode(wallet: string): string {
        const existing = this.db.query<{ code: string }, [string]>(
            "SELECT code FROM referral_codes WHERE wallet = ?",
        ).get(wallet);
        if (existing) return existing.code;

        // Generate a short unique code (6 chars, alphanumeric)
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
        let code: string;
        let attempts = 0;
        do {
            code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
            const conflict = this.db.query<{ code: string }, [string]>(
                "SELECT code FROM referral_codes WHERE code = ?",
            ).get(code);
            if (!conflict) break;
            attempts++;
        } while (attempts < 20);

        this.db.run(
            "INSERT INTO referral_codes (wallet, code, created_at) VALUES (?, ?, ?)",
            [wallet, code, Date.now()],
        );
        return code;
    }

    /** Look up the wallet that owns a referral code. */
    getReferrerByCode(code: string): string | null {
        const row = this.db.query<{ wallet: string }, [string]>(
            "SELECT wallet FROM referral_codes WHERE code = ?",
        ).get(code);
        return row?.wallet ?? null;
    }

    /** Record a referral signup. Returns false if already referred. */
    recordReferralSignup(referredWallet: string, referrerWallet: string, referrerCode: string): boolean {
        try {
            this.db.run(
                "INSERT INTO referral_signups (referred_wallet, referrer_wallet, referrer_code, points, created_at) VALUES (?, ?, ?, 100, ?)",
                [referredWallet, referrerWallet, referrerCode, Date.now()],
            );
            return true;
        } catch {
            // Unique constraint violation — already referred
            return false;
        }
    }

    /** Get referral stats for a wallet. */
    getReferralStats(wallet: string): { total_referrals: number; total_points: number } {
        const row = this.db.query<{ cnt: number; pts: number }, [string]>(
            "SELECT COUNT(*) as cnt, COALESCE(SUM(points), 0) as pts FROM referral_signups WHERE referrer_wallet = ?",
        ).get(wallet);
        return {
            total_referrals: row?.cnt ?? 0,
            total_points: row?.pts ?? 0,
        };
    }

    /** Get all wallets that were referred by a given referrer. */
    getReferredWallets(referrerWallet: string): string[] {
        const rows = this.db.query<{ referred_wallet: string }, [string]>(
            "SELECT referred_wallet FROM referral_signups WHERE referrer_wallet = ?",
        ).all(referrerWallet);
        return rows.map(r => r.referred_wallet);
    }

    /** Check if a wallet was already referred by someone. */
    isAlreadyReferred(wallet: string): boolean {
        const row = this.db.query<{ referred_wallet: string }, [string]>(
            "SELECT referred_wallet FROM referral_signups WHERE referred_wallet = ?",
        ).get(wallet);
        return !!row;
    }

    /** Get the wallet that referred this wallet, or null if not referred. */
    getReferredBy(wallet: string): string | null {
        const row = this.db.query<{ referrer_wallet: string }, [string]>(
            "SELECT referrer_wallet FROM referral_signups WHERE referred_wallet = ?",
        ).get(wallet);
        return row?.referrer_wallet ?? null;
    }

    /** Get ALL referral codes (admin only). */
    getAllReferralCodes(): Array<{ wallet: string; code: string; created_at: number }> {
        return this.db.query<{ wallet: string; code: string; created_at: number }, []>(
            "SELECT wallet, code, created_at FROM referral_codes ORDER BY created_at DESC",
        ).all();
    }

    /** Get ALL referral signups (admin only). */
    getAllReferralSignups(): Array<{
        referred_wallet: string; referrer_wallet: string; referrer_code: string;
        points: number; created_at: number;
    }> {
        return this.db.query<{
            referred_wallet: string; referrer_wallet: string; referrer_code: string;
            points: number; created_at: number;
        }, []>(
            "SELECT * FROM referral_signups ORDER BY created_at DESC",
        ).all();
    }

    /** Get the referral leaderboard. */
    getReferralLeaderboard(limit = 50): Array<{ wallet: string; total_referrals: number; total_points: number }> {
        return this.db.query<{ wallet: string; total_referrals: number; total_points: number }, [number]>(
            `SELECT referrer_wallet as wallet, COUNT(*) as total_referrals, SUM(points) as total_points
             FROM referral_signups
             GROUP BY referrer_wallet
             ORDER BY total_referrals DESC
             LIMIT ?`,
        ).all(limit);
    }

    /** Get a wallet's rank on the leaderboard (1-indexed), or null if not on it. */
    getReferralRank(wallet: string): number | null {
        const row = this.db.query<{ rank: number }, [string]>(
            `SELECT rank FROM (
                SELECT referrer_wallet, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) as rank
                FROM referral_signups
                GROUP BY referrer_wallet
            ) WHERE referrer_wallet = ?`,
        ).get(wallet);
        return row?.rank ?? null;
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        this.db.close();
        L.info("Database closed");
    }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: CardDatabase | null = null;

export function initDatabase(dataDir: string): CardDatabase {
    if (_instance) return _instance;
    const dbPath = join(dataDir, "cards.db");
    _instance = new CardDatabase(dbPath);
    return _instance;
}

export function db(): CardDatabase {
    if (!_instance) throw new Error("CardDatabase not initialized — call initDatabase() first");
    return _instance;
}

export function closeDatabase(): void {
    if (_instance) {
        _instance.close();
        _instance = null;
    }
}
