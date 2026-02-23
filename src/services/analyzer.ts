/**
 * CardAnalyzer — seven-criterion scoring for perpetual trading suitability.
 *
 * Criteria (weights):
 *   1. Oracle Reliability   (25%) — can we trust the price feed?
 *   2. Market Depth         (20%) — is the card liquid enough?
 *   3. Transaction Volume   (18%) — are people actually trading it?
 *   4. Price Level          (12%) — is it above the noise floor?
 *   5. Volatility Character (10%) — smooth movement or dangerous gaps?
 *   6. Manipulation Resist. (10%) — how hard is it to spike the oracle?
 *   7. Demand Persistence    (5%) — will this card still trade next month?
 *
 * Design principles:
 *   - Archive data (TCGCSV) provides the deterministic base ranking.
 *     Even with zero live data, the algorithm produces a stable, sensible order.
 *   - Live data (pricing, sales, listings, history) enhances the ranking
 *     when available but never makes it worse or unstable.
 *   - All sorts use product_id as a tiebreaker for determinism.
 */

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

import { env } from "../env";
import { log } from "../log";
const L = log("analyzer");
import { db, CardDatabase } from "./db";
import type {
    PerpMetrics,
    AnalysisResult,
    AnalysisSummary,
    CardAnalysis,
    CardInfo,
    PriceData,
    ProductPricing,
    Sale,
    Listing,
    PriceHistory,
} from "../models";

// ── Live data snapshot per product ──────────────────────────────────────────

interface LiveSnapshot {
    pricing: ProductPricing | null;
    sales: Sale[] | null;
    listings: Listing[] | null;
    history: PriceHistory | null;
}

// ── Math helpers ────────────────────────────────────────────────────────────

function r2(n: number): number { return Math.round(n * 100) / 100; }
function r4(n: number): number { return Math.round(n * 10000) / 10000; }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

// ── Criterion 1: Oracle Reliability (25%) ───────────────────────────────────
// DETERMINISTIC: uses only archive data (dates + prices). No live data.

function scoreOracle(
    prices: (number | null)[],
): { score: number; dataAvailability: number; stalenessDays: number } {
    // Data availability: what fraction of the archive window has valid prices?
    const totalDays = prices.length;
    let validDays = 0;
    for (const p of prices) if (p !== null && p > 0) validDays++;
    const dataAvailability = totalDays > 0 ? validDays / totalDays : 0;

    // Staleness: count consecutive identical prices at the END of the series.
    // If the last 10 entries are all $4.99, the oracle is stale.
    let stalenessDays = 0;
    const validPrices: number[] = [];
    for (const p of prices) if (p !== null && p > 0) validPrices.push(p);
    if (validPrices.length >= 2) {
        const last = validPrices[validPrices.length - 1];
        for (let i = validPrices.length - 2; i >= 0; i--) {
            if (Math.abs(validPrices[i] - last) < 0.005) stalenessDays++;
            else break;
        }
    }

    // Staleness penalty: 0 stale days → 1.0, 5+ → 0.0
    const freshness = clamp(1 - stalenessDays / 5, 0, 1);

    // Weighted: availability 55%, freshness 45%
    const score = r2(clamp(dataAvailability, 0, 1) * 55 + freshness * 45);

    return { score, dataAvailability: r4(dataAvailability), stalenessDays };
}

/**
 * Price source agreement — computed from live data for DISPLAY only.
 * Not used in the ranking score.
 */
function computeAgreement(archivePrice: number, live: LiveSnapshot): number {
    if (archivePrice <= 0 || !live.pricing?.market_price || live.pricing.market_price <= 0) return 0.5;
    const livePrice = live.pricing.market_price;
    const archiveDev = Math.abs(archivePrice - livePrice) / livePrice;
    let saleDev = 0;
    if (live.sales && live.sales.length >= 3) {
        const salePrices = live.sales.map(s => s.price).filter(p => p > 0).sort((a, b) => a - b);
        if (salePrices.length >= 3) {
            const median = salePrices[Math.floor(salePrices.length / 2)];
            saleDev = Math.abs(livePrice - median) / livePrice;
        }
    }
    return r4(clamp(1 - Math.max(archiveDev, saleDev) / 0.20, 0, 1));
}

// ── Criterion 2: Market Depth (20%) ─────────────────────────────────────────

function scoreDepth(live: LiveSnapshot): {
    score: number; listingCount: number; sellerCount: number; spreadTightness: number;
} {
    if (!live.pricing) {
        return { score: 0, listingCount: 0, sellerCount: 0, spreadTightness: 0 };
    }

    const listings = live.pricing.listings;
    const sellers = live.pricing.sellers;

    // Listing depth: saturates at 80
    const listingNorm = clamp(listings / 80, 0, 1);
    // Seller diversity: saturates at 15
    const sellerNorm = clamp(sellers / 15, 0, 1);

    // Spread tightness
    let spreadTightness = 0;
    const mp = live.pricing.market_price;
    const lp = live.pricing.lowest_price;
    if (mp && mp > 0 && lp && lp > 0 && lp <= mp) {
        spreadTightness = clamp(1 - (mp - lp) / mp, 0, 1);
    }

    // Weighted: listings 40%, sellers 35%, spread 25%
    const score = r2(listingNorm * 40 + sellerNorm * 35 + spreadTightness * 25);

    return { score, listingCount: listings, sellerCount: sellers, spreadTightness: r4(spreadTightness) };
}

// ── Criterion 3: Transaction Volume (18%) ───────────────────────────────────

function countRecentSales(sales: Sale[], days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    let count = 0;
    for (const s of sales) {
        const ts = new Date(s.order_date).getTime();
        if (Number.isFinite(ts) && ts >= cutoff) count += s.quantity;
    }
    return count;
}

function scoreVolume(live: LiveSnapshot): {
    score: number; sales7d: number; sales30d: number; avgDailyVolume: number;
} {
    let sales7d = 0, sales30d = 0;
    if (live.sales && live.sales.length > 0) {
        sales7d = countRecentSales(live.sales, 7);
        sales30d = countRecentSales(live.sales, 30);
    }

    let avgDailyVolume = 0;
    if (live.history?.skus) {
        for (const sku of live.history.skus) {
            if (sku.average_daily_quantity_sold > 0) {
                avgDailyVolume += sku.average_daily_quantity_sold;
            }
        }
    }

    // Normalize: 7d sales saturates at 25, 30d at 60, daily avg at 5
    const s7 = clamp(sales7d / 25, 0, 1);
    const s30 = clamp(sales30d / 60, 0, 1);
    const dv = clamp(avgDailyVolume / 5, 0, 1);

    // Weighted: 7d 50%, 30d 25%, daily avg 25%
    const score = r2(s7 * 50 + s30 * 25 + dv * 25);

    return { score, sales7d, sales30d, avgDailyVolume: r4(avgDailyVolume) };
}

// ── Criterion 4: Price Level (12%) ──────────────────────────────────────────

const PRICE_FLOOR = 2.00;   // hard minimum — below this, score = 0
const PRICE_SWEET = 10.00;  // optimal starts here
const PRICE_CAP = 500.00;   // above this, full marks

function scorePrice(currentPrice: number): number {
    if (currentPrice < PRICE_FLOOR) return 0;
    if (currentPrice >= PRICE_CAP) return 100;

    // Logarithmic ramp: $2 → ~20, $10 → ~70, $50 → ~90, $500 → 100
    const logNorm = (Math.log10(currentPrice) - Math.log10(PRICE_FLOOR))
                  / (Math.log10(PRICE_CAP) - Math.log10(PRICE_FLOOR));
    return r2(clamp(logNorm, 0, 1) * 100);
}

// ── Criterion 5: Volatility Character (10%) ─────────────────────────────────

function scoreVolatility(prices: (number | null)[]): {
    score: number; dailyChangeAvg: number; changeFrequency: number; maxSingleDayMove: number;
} {
    const valid: number[] = [];
    for (const p of prices) if (p !== null && p > 0) valid.push(p);
    if (valid.length < 5) {
        return { score: 0, dailyChangeAvg: 0, changeFrequency: 0, maxSingleDayMove: 0 };
    }

    let changeCount = 0;
    let totalAbsChange = 0;
    let maxMove = 0;

    for (let i = 1; i < valid.length; i++) {
        const pctChange = Math.abs(valid[i] - valid[i - 1]) / valid[i - 1];
        totalAbsChange += pctChange;
        if (pctChange > 0.001) changeCount++;
        if (pctChange > maxMove) maxMove = pctChange;
    }

    const pairs = valid.length - 1;
    const dailyChangeAvg = totalAbsChange / pairs;
    const changeFrequency = changeCount / pairs;

    // GOOD: daily change avg between 0.5% and 3% (sweet spot for perp trading)
    // Below 0.5%: flatline, no trading interest
    // Above 3%: too volatile, gap risk
    let volGoodness: number;
    if (dailyChangeAvg < 0.005) {
        volGoodness = dailyChangeAvg / 0.005; // ramp 0→1 for 0%→0.5%
    } else if (dailyChangeAvg <= 0.03) {
        volGoodness = 1.0; // sweet spot
    } else {
        volGoodness = clamp(1 - (dailyChangeAvg - 0.03) / 0.07, 0, 0.3); // rapid decay above 3%
    }

    // PENALTY for gap risk: max single-day move above 15% is bad
    const gapPenalty = maxMove > 0.15 ? clamp(1 - (maxMove - 0.15) / 0.35, 0, 1) : 1.0;

    // BONUS for continuous movement (change frequency 0.3-0.8 is ideal)
    const freqBonus = changeFrequency >= 0.3 && changeFrequency <= 0.8
        ? 1.0
        : changeFrequency < 0.3
            ? changeFrequency / 0.3
            : clamp(1 - (changeFrequency - 0.8) / 0.2, 0.5, 1);

    const score = r2(volGoodness * 50 * gapPenalty + freqBonus * 50);

    return {
        score,
        dailyChangeAvg: r4(dailyChangeAvg),
        changeFrequency: r4(changeFrequency),
        maxSingleDayMove: r4(maxMove),
    };
}

// ── Criterion 6: Manipulation Resistance (10%) ──────────────────────────────

function scoreManipulation(live: LiveSnapshot): {
    score: number; sellerHhi: number; depthNearMarket: number;
} {
    if (!live.listings || live.listings.length === 0) {
        // No listing data — use a default moderate score from pricing alone
        if (live.pricing && live.pricing.sellers > 5) {
            return { score: 30, sellerHhi: 0.5, depthNearMarket: 0 };
        }
        return { score: 0, sellerHhi: 1, depthNearMarket: 0 };
    }

    // Seller Herfindahl-Hirschman Index: sum of (seller_share)^2
    // Lower is better (more diversified). 1.0 = monopoly, ~0 = perfectly distributed
    const sellerQty = new Map<string, number>();
    let totalQty = 0;
    for (const l of live.listings) {
        sellerQty.set(l.seller_name, (sellerQty.get(l.seller_name) ?? 0) + l.quantity);
        totalQty += l.quantity;
    }
    let hhi = 0;
    if (totalQty > 0) {
        for (const qty of sellerQty.values()) {
            const share = qty / totalQty;
            hhi += share * share;
        }
    }

    // Depth near market: count listings within 15% of the lowest price
    let depthNearMarket = 0;
    if (live.listings.length > 0) {
        const lowestPrice = Math.min(...live.listings.map(l => l.price).filter(p => p > 0));
        const ceiling = lowestPrice * 1.15;
        for (const l of live.listings) {
            if (l.price > 0 && l.price <= ceiling) depthNearMarket += l.quantity;
        }
    }

    // HHI score: < 0.10 = excellent (score 100), > 0.50 = terrible (score 0)
    const hhiScore = clamp((0.50 - hhi) / 0.40, 0, 1) * 60;

    // Depth score: saturates at 30 units near market
    const depthScore = clamp(depthNearMarket / 30, 0, 1) * 40;

    return {
        score: r2(hhiScore + depthScore),
        sellerHhi: r4(hhi),
        depthNearMarket,
    };
}

// ── Criterion 7: Demand Persistence (5%) ────────────────────────────────────
// DETERMINISTIC: uses only archive valid day count.

function scorePersistence(validDays: number): { score: number } {
    // Data longevity: saturates at 180 days of valid data
    const score = r2(clamp(validDays / 180, 0, 1) * 100);
    return { score };
}

/** Volume trend — computed from live data for DISPLAY only. */
function computeVolumeTrend(sales7d: number, sales30d: number): number {
    const pace = sales30d > 0 ? (sales7d / (sales30d / 4.3)) : (sales7d > 0 ? 1 : 0);
    return r4(clamp(pace, 0, 1.5));
}

// ── Price at N days ago (relative to last archive date, NOT Date.now()) ──────
// DETERMINISTIC: reference point is the last date in the archive series.

function priceNDaysAgo(dates: string[], prices: (number | null)[], daysAgo: number): number | null {
    if (dates.length === 0) return null;
    // Use the last archive date as the reference point (not Date.now())
    const refMs = new Date(dates[dates.length - 1]).getTime();
    if (!Number.isFinite(refMs)) return null;
    const targetMs = refMs - daysAgo * 86_400_000;

    let bestPrice: number | null = null;
    let bestDist = Infinity;

    for (let i = 0; i < dates.length; i++) {
        const p = prices[i];
        if (p === null || p <= 0) continue;
        const dist = Math.abs(new Date(dates[i]).getTime() - targetMs) / 86_400_000;
        if (dist < bestDist) { bestDist = dist; bestPrice = p; }
    }
    return bestDist <= 3 ? bestPrice : null;
}

// ── Composite scorer (DETERMINISTIC — archive data only) ─────────────────────
//
// Only criteria derived from TCGCSV archives feed into the ranking score.
// Live-dependent criteria (depth, volume, manipulation) are computed for
// display in PerpMetrics but do NOT affect the sort order.
//
// Weights (re-normalized to sum to 1.0 from the archive-only subset):
//   Oracle Reliability  42%  (was 25% of 100%)
//   Price Level         20%  (was 12%)
//   Volatility Char.    22%  (was 10%)
//   Demand Persistence  16%  (was  5%)

const RANK_WEIGHTS = {
    oracle: 0.42,
    price: 0.20,
    volatility: 0.22,
    persistence: 0.16,
} as const;

function rankingScore(metrics: {
    oracle: number; price: number; volatility: number; persistence: number;
}): number {
    return r2(
        metrics.oracle * RANK_WEIGHTS.oracle +
        metrics.price * RANK_WEIGHTS.price +
        metrics.volatility * RANK_WEIGHTS.volatility +
        metrics.persistence * RANK_WEIGHTS.persistence,
    );
}

// ── CardAnalyzer class ──────────────────────────────────────────────────────

export class CardAnalyzer {
    private cfg = env();
    private memoryCache: AnalysisResult | null = null;
    private memoryCacheTime: Date | null = null;
    private bulkNames = new Map<number, string>();
    // Mutex to prevent concurrent analysis runs
    private analysisInProgress: Promise<AnalysisResult> | null = null;

    constructor() {}

    async init(): Promise<void> {
        // DB is already initialized globally — nothing to do here
    }

    loadBulkProductNames(names: Map<number, string>): void {
        this.bulkNames = names;
        this.memoryCache = null;
        this.memoryCacheTime = null;
    }

    // ── Archive data helpers ─────────────────────────────────────────────────

    private static estimateMarketPrice(
        low: number | null | undefined,
        mid: number | null | undefined,
        high: number | null | undefined,
    ): number | null {
        if (mid != null && mid > 0) return Math.round(mid * 1.12 * 100) / 100;
        if (low != null && high != null && low > 0 && high > 0)
            return Math.round(((low + high) / 2) * 1.05 * 100) / 100;
        if (low != null && low > 0) return Math.round(low * 1.93 * 100) / 100;
        if (high != null && high > 0) return Math.round(high * 0.4 * 100) / 100;
        return null;
    }

    private async loadPricesFromFile(path: string): Promise<PriceData[]> {
        try {
            const raw = await readFile(path, "utf-8");
            const data = JSON.parse(raw);
            if (!data.success) return [];
            const out: PriceData[] = [];
            for (const r of data.results ?? []) {
                if (!r.productId) continue;
                let mp = r.marketPrice;
                if (mp == null) mp = CardAnalyzer.estimateMarketPrice(r.lowPrice, r.midPrice, r.highPrice);
                if (mp == null || mp <= 0) continue;
                out.push({ product_id: r.productId, market_price: mp, sub_type: r.subTypeName ?? "Unknown" });
            }
            return out;
        } catch { return []; }
    }

    private async getAllGroups(categoryId: number): Promise<string[]> {
        const groups = new Set<string>();
        const base = this.cfg.paths.archivesJson;
        if (!existsSync(base)) return [];
        try {
            const dateDirs = await readdir(base, { withFileTypes: true });
            for (const d of dateDirs) {
                if (!d.isDirectory() || d.name.startsWith("_")) continue;
                const catDir = join(base, d.name, String(categoryId));
                if (!existsSync(catDir)) continue;
                const groupDirs = await readdir(catDir, { withFileTypes: true });
                for (const g of groupDirs) {
                    if (g.isDirectory()) groups.add(g.name);
                }
            }
        } catch { /* ignore */ }
        return [...groups].sort();
    }

    private async collectGroupData(categoryId: number, groupId: string): Promise<Map<string, CardInfo>> {
        const cards = new Map<string, CardInfo>();
        const base = this.cfg.paths.archivesJson;
        if (!existsSync(base)) return cards;
        
        let dateDirNames: string[];
        try {
            const dateDirs = await readdir(base, { withFileTypes: true });
            dateDirNames = dateDirs
                .filter(d => d.isDirectory() && !d.name.startsWith("_"))
                .map(d => d.name).sort();
        } catch {
            return cards;
        }
        
        const recent = dateDirNames.slice(-(this.cfg.analysis.rollingWindowDays + 5));

        for (const dateStr of recent) {
            if (isNaN(new Date(dateStr).getTime())) continue;
            const pricesFile = join(base, dateStr, String(categoryId), groupId, "prices.json");
            if (!existsSync(pricesFile)) continue;
            for (const pd of await this.loadPricesFromFile(pricesFile)) {
                const key = `${pd.product_id}_${pd.sub_type}`;
                if (!cards.has(key)) {
                    cards.set(key, {
                        product_id: pd.product_id, category: categoryId,
                        group: groupId, sub_type: pd.sub_type, dates: [], prices: [],
                    });
                }
                const info = cards.get(key)!;
                info.dates.push(dateStr);
                info.prices.push(pd.market_price);
            }
        }
        return cards;
    }

    // ── Single card scoring ──────────────────────────────────────────────────

    private scoreCard(info: CardInfo, live: LiveSnapshot): CardAnalysis | null {
        if (info.prices.length < this.cfg.analysis.minDataPoints) return null;

        const valid = info.prices.filter((p): p is number => p !== null && p > 0);
        if (valid.length < 5) return null;

        const latest = valid[valid.length - 1];

        // ── Archive-only criteria (deterministic, used for ranking) ──
        const oracle = scoreOracle(info.prices);
        const validDayCount = Math.round(oracle.dataAvailability * info.prices.length);
        const priceScr = scorePrice(latest);
        const volatility = scoreVolatility(info.prices);
        const persistence = scorePersistence(validDayCount);

        const perpScore = rankingScore({
            oracle: oracle.score,
            price: priceScr,
            volatility: volatility.score,
            persistence: persistence.score,
        });

        // ── Live-only criteria (for display, NOT ranking) ──
        const depth = scoreDepth(live);
        const vol = scoreVolume(live);
        const manipulation = scoreManipulation(live);
        const agreement = computeAgreement(latest, live);
        const volumeTrend = computeVolumeTrend(vol.sales7d, vol.sales30d);

        // Price changes (relative to last archive date — deterministic)
        const price1d = priceNDaysAgo(info.dates, info.prices, 1);
        const price30d = priceNDaysAgo(info.dates, info.prices, 30);
        const change24h = price1d && price1d > 0 ? r2(((latest - price1d) / price1d) * 100) : 0;
        const change30d = price30d && price30d > 0 ? r2(((latest - price30d) / price30d) * 100) : 0;

        const name = this.bulkNames.get(info.product_id) ?? `Product ${info.product_id}`;

        return {
            product_id: info.product_id,
            product_name: name,
            category: info.category,
            group: info.group,
            sub_type: info.sub_type,
            date_range_start: info.dates[0] ?? "",
            date_range_end: info.dates[info.dates.length - 1] ?? "",
            total_days: info.dates.length,
            activity_score: perpScore,
            change_24h: change24h,
            change_30d: change30d,
            current_price: r2(latest),
            min_price: r2(Math.min(...valid)),
            max_price: r2(Math.max(...valid)),
            mean_price: r2(valid.reduce((a, b) => a + b, 0) / valid.length),
            activity: {
                perp_score: perpScore,

                // Archive-only (deterministic, feeds ranking)
                oracle_score: oracle.score,
                data_availability: oracle.dataAvailability,
                staleness_days: oracle.stalenessDays,
                price_source_agreement: agreement,    // display only

                // Live-only (display only, does NOT affect ranking)
                depth_score: depth.score,
                listing_count: depth.listingCount,
                seller_count: depth.sellerCount,
                spread_tightness: depth.spreadTightness,

                volume_score: vol.score,
                sales_7d: vol.sales7d,
                sales_30d: vol.sales30d,
                avg_daily_volume: vol.avgDailyVolume,

                price_score: priceScr,
                current_price: r2(latest),

                volatility_score: volatility.score,
                daily_change_avg: volatility.dailyChangeAvg,
                change_frequency: volatility.changeFrequency,
                max_single_day_move: volatility.maxSingleDayMove,

                manipulation_score: manipulation.score,
                seller_hhi: manipulation.sellerHhi,
                depth_near_market: manipulation.depthNearMarket,

                persistence_score: persistence.score,
                valid_days: validDayCount,
                volume_trend: volumeTrend,           // display only
            },
        };
    }

    // ── Main analysis pipeline ───────────────────────────────────────────────

    async analyze(force = false): Promise<AnalysisResult> {
        const CACHE_KEY = "card_analysis_v3";
        const MAX_AGE = 3600;

        // In-memory cache (sync check - no race condition)
        if (!force && this.memoryCache && this.memoryCacheTime) {
            const age = (Date.now() - this.memoryCacheTime.getTime()) / 1000;
            if (age < MAX_AGE) return this.memoryCache;
        }

        // If analysis is already running, wait for it instead of starting another.
        // This check + assignment pattern works because JavaScript is single-threaded:
        // between the check and the assignment, no other code can run (no await in between).
        if (this.analysisInProgress) {
            L.debug("Analysis already in progress, waiting...");
            return this.analysisInProgress;
        }

        // Create the analysis promise and assign it SYNCHRONOUSLY before any await.
        // This ensures no other caller can slip in between check and assignment.
        const analysisPromise = this.runAnalysisWithCache(CACHE_KEY, MAX_AGE, force);
        this.analysisInProgress = analysisPromise;

        try {
            return await analysisPromise;
        } finally {
            this.analysisInProgress = null;
        }
    }

    private async runAnalysisWithCache(CACHE_KEY: string, MAX_AGE: number, force: boolean): Promise<AnalysisResult> {
        // SQLite analysis table check (now inside the mutex-protected section)
        if (!force) {
            const meta = db().getAnalysisMetadata();
            if (meta) {
                const ageSeconds = (Date.now() - new Date(meta.generated_at).getTime()) / 1000;
                if (ageSeconds < MAX_AGE) {
                    const result = this.loadAnalysisFromDb(meta);
                    this.memoryCache = result;
                    this.memoryCacheTime = new Date();
                    L.info(`Loaded ${result.metadata.total_cards_analyzed} cards from SQLite (age: ${(ageSeconds / 60).toFixed(1)}min)`);
                    return result;
                }
            }
        }

        L.info("Running fresh analysis...");
        return this.runAnalysis(CACHE_KEY);
    }

    /** Reconstruct a full AnalysisResult from SQLite tables. */
    private loadAnalysisFromDb(meta: NonNullable<ReturnType<CardDatabase["getAnalysisMetadata"]>>): AnalysisResult {
        // Single query: fetch ALL analysis rows with full data (no N+1)
        const allCount = db().getAnalysisCount();
        const topRows = db().getTopAnalysis(allCount);
        const allIds = new Set(topRows.map(r => r.product_id));
        const fullRows = db().getAnalysisForIds(allIds);

        // Build map from full rows for O(1) lookup
        const fullMap = new Map<number, (typeof fullRows)[number]>();
        for (const r of fullRows) fullMap.set(r.product_id, r);

        const allCards: CardAnalysis[] = topRows.map(r => {
            const full = fullMap.get(r.product_id);
            return {
                product_id: r.product_id,
                product_name: r.product_name,
                category: r.category,
                group: r.group,
                sub_type: r.sub_type,
                date_range_start: full?.date_range_start ?? "",
                date_range_end: full?.date_range_end ?? "",
                total_days: full?.total_days ?? 0,
                activity_score: r.activity_score,
                change_24h: r.change_24h,
                change_30d: r.change_30d,
                current_price: r.current_price,
                min_price: r.min_price,
                max_price: r.max_price,
                mean_price: r.mean_price,
                activity: full?.activity as PerpMetrics | null ?? null,
            };
        });

        const enriched = this.enrichNames({ metadata: meta as AnalysisSummary, all_cards: allCards, top_tradable: [], top_active: [] });
        const topTradable = enriched.all_cards.slice(0, 200);
        return {
            metadata: meta as AnalysisSummary,
            all_cards: enriched.all_cards,
            top_tradable: topTradable,
            top_active: topTradable.slice(0, 100),
        };
    }

    private async runAnalysis(CACHE_KEY: string): Promise<AnalysisResult> {

        // Lazy-import to avoid circular deps
        const { tcgplayer } = await import("./tcgplayer");
        const client = tcgplayer();

        // Phase 1: Collect all card data from archives
        const allCardInfos: CardInfo[] = [];
        for (const catId of this.cfg.analysis.categories) {
            const groups = await this.getAllGroups(catId);
            for (const gid of groups) {
                const cardData = await this.collectGroupData(catId, gid);
                for (const info of cardData.values()) allCardInfos.push(info);
            }
        }

        // Phase 2: Filter to actual cards only (exclude sealed products, accessories, etc.)
        // This regex matches product names that are NOT individual cards
        const SEALED_NAME_PATTERNS = /\b(booster\s*(box|pack|bundle)|elite\s*trainer\s*box|etb|blister|tin[s]?\b|collection\s*(box)?|display|case\b|build\s*&?\s*battle|poster|binder|sleeves|deck\s*box|playmat|album|storage|protectors|premium\s*(box|collection)|special\s*(box|set)|sticker|lunch\s*box|collector('?s)?\s*(chest|box|tin)|pokemon\s*center|figure|plush|pin\b|coin\b|promo\s*(pack|cards?\s*bundle)|celebrations|anniversary\s*(box|set|collection)|golden\s*box|set\s*of\s*\d+|ultra\s*premium|treasure\s*chest|mini\s*(tin|album|binder)|trainer\s*gallery|poke\s*ball|card\s*game|lunchbox|sam'?s\s*club|costco|walmart\s*exclusive|target\s*exclusive|\d+\s*(mini\s*)?tins?|\d+\s*packs?|bundle\)?$|sealed|japanese\s*(box|booster|pack))\b/i;
        const uniqueIds = [...new Set(allCardInfos.map(c => c.product_id))];
        const sealedIds = new Set<number>();
        // Process in batches to avoid memory pressure from too many concurrent promises
        const BATCH_SIZE = 500;
        for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
            const batch = uniqueIds.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (pid) => {
                const info = await client.getCachedProductInfoRaw(pid);
                // Filter by product_type_name if available
                if (info && info.product_type_name && info.product_type_name !== "Cards") {
                    sealedIds.add(pid);
                    return;
                }
                // Also check product name for sealed/accessory keywords (even if info exists)
                const name = info?.product_name ?? this.bulkNames.get(pid) ?? "";
                if (name && SEALED_NAME_PATTERNS.test(name)) {
                    sealedIds.add(pid);
                }
            }));
        }
        const cardInfos = sealedIds.size > 0
            ? allCardInfos.filter(c => !sealedIds.has(c.product_id))
            : allCardInfos;
        if (sealedIds.size > 0) {
            L.info(`Filtered out ${sealedIds.size} sealed/non-card products`);
        }

        // Phase 3: Fetch live snapshots (all from cache — no network)
        // Process in batches to avoid memory pressure
        const cardIds = [...new Set(cardInfos.map(c => c.product_id))];
        const liveMap = new Map<number, LiveSnapshot>();
        for (let i = 0; i < cardIds.length; i += BATCH_SIZE) {
            const batch = cardIds.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (pid) => {
                const [pricing, sales, listings, history] = await Promise.all([
                    client.getCachedPricingRaw(pid),
                    client.getCachedSalesRaw(pid),
                    client.getCachedListingsRaw(pid),
                    client.getCachedHistoryRaw(pid, "month"),
                ]);
                liveMap.set(pid, { pricing, sales, listings, history });
            }));
        }

        // Phase 4: Score each card
        const allCards: CardAnalysis[] = [];
        for (const info of cardInfos) {
            const live = liveMap.get(info.product_id) ?? { pricing: null, sales: null, listings: null, history: null };
            const card = this.scoreCard(info, live);
            if (card) allCards.push(card);
        }

        // Free memory from large intermediate structures
        liveMap.clear();

        // Deduplicate by product_id (keep highest score, prefer named)
        const seen = new Map<number, CardAnalysis>();
        for (const card of allCards) {
            const existing = seen.get(card.product_id);
            if (!existing) { seen.set(card.product_id, card); continue; }
            const cardNamed = !card.product_name.startsWith("Product ");
            const existNamed = !existing.product_name.startsWith("Product ");
            if (cardNamed && !existNamed) seen.set(card.product_id, card);
            else if (cardNamed === existNamed && card.activity_score > existing.activity_score)
                seen.set(card.product_id, card);
        }

        // Deterministic sort: score descending, then product_id ascending
        const deduped = [...seen.values()].sort((a, b) =>
            b.activity_score - a.activity_score || a.product_id - b.product_id,
        );
        const topTradable = deduped.slice(0, 200);

        const scores = deduped.map(c => c.activity_score);
        const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        const sorted = [...scores].sort((a, b) => a - b);
        const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;

        const result: AnalysisResult = {
            metadata: {
                generated_at: new Date().toISOString(),
                total_cards_analyzed: deduped.length,
                categories: [...this.cfg.analysis.categories],
                rolling_window_days: this.cfg.analysis.rollingWindowDays,
                most_active_card: deduped[0]?.product_name ?? null,
                avg_activity_score: r2(avg),
                median_activity_score: r2(median),
                high_activity_count: deduped.filter(c => c.activity_score > 50).length,
            },
            all_cards: deduped,
            top_tradable: topTradable,
            top_active: topTradable.slice(0, 100),
        };

        this.memoryCache = result;
        this.memoryCacheTime = new Date();

        // Persist to SQLite
        try {
            const analysisRows = deduped.map(c => ({
                product_id: c.product_id,
                product_name: c.product_name,
                category: c.category,
                group: c.group,
                sub_type: c.sub_type,
                date_range_start: c.date_range_start,
                date_range_end: c.date_range_end,
                total_days: c.total_days,
                activity_score: c.activity_score,
                change_24h: c.change_24h,
                change_30d: c.change_30d,
                current_price: c.current_price,
                min_price: c.min_price,
                max_price: c.max_price,
                mean_price: c.mean_price,
                activity: c.activity,
            }));
            const written = db().upsertAnalysisBatch(analysisRows);
            db().upsertAnalysisMetadata(result.metadata);
            L.info(`Cached ${written} cards to SQLite`);
        } catch (e) {
            L.error("SQLite write failed:", e);
        }

        return result;
    }

    /**
     * Non-blocking: return cached analysis instantly (memory → persistent file, ignoring TTL).
     * Returns null ONLY if no cache exists at all. Never triggers a fresh analysis run.
     * If analysis is stale, kicks off a background refresh (fire-and-forget).
     */
    async getCached(): Promise<AnalysisResult | null> {
        const MAX_AGE = 3600;

        // 1. Check in-memory cache (any age)
        if (this.memoryCache) {
            // If stale, trigger background refresh
            if (this.memoryCacheTime) {
                const age = (Date.now() - this.memoryCacheTime.getTime()) / 1000;
                if (age >= MAX_AGE) this.refreshInBackground();
            }
            return this.memoryCache;
        }

        // 2. Check SQLite analysis table (any age — stale-while-revalidate)
        const meta = db().getAnalysisMetadata();
        if (meta && db().getAnalysisCount() > 0) {
            const result = this.loadAnalysisFromDb(meta);
            // Populate memory cache so subsequent calls are instant
            this.memoryCache = result;
            this.memoryCacheTime = new Date(0); // mark as stale age
            L.info(`Loaded ${result.metadata.total_cards_analyzed} cards from SQLite (non-blocking)`);
            // Trigger background refresh
            this.refreshInBackground();
            return result;
        }

        // 3. Nothing cached at all — return null (caller must degrade gracefully)
        this.refreshInBackground();
        return null;
    }

    /**
     * Non-blocking findCard: uses direct SQL query.
     * Falls back to in-memory cache if available.
     */
    async findCardCached(productId: number): Promise<CardAnalysis | null> {
        // Try direct SQL query first (fast, no full-table scan)
        const row = db().getAnalysis(productId);
        if (row) {
            const name = this.bulkNames.get(productId) ?? row.product_name;
            return {
                product_id: row.product_id,
                product_name: name.startsWith("Product ") ? (this.bulkNames.get(row.product_id) ?? name) : name,
                category: row.category,
                group: row.group,
                sub_type: row.sub_type,
                date_range_start: row.date_range_start,
                date_range_end: row.date_range_end,
                total_days: row.total_days,
                activity_score: row.activity_score,
                change_24h: row.change_24h,
                change_30d: row.change_30d,
                current_price: row.current_price,
                min_price: row.min_price,
                max_price: row.max_price,
                mean_price: row.mean_price,
                activity: row.activity as PerpMetrics | null,
            };
        }
        // Fallback to memory cache
        if (this.memoryCache) {
            return this.memoryCache.all_cards.find(c => c.product_id === productId) ?? null;
        }
        return null;
    }

    /**
     * Fire-and-forget: trigger analysis in background if not already running.
     */
    private refreshInBackground(): void {
        if (this.analysisInProgress) return; // already running
        // Fire and forget — don't await
        this.analyze(false).catch(e => {
            L.error("Background analysis refresh failed:", e);
        });
    }

    async findCard(productId: number): Promise<CardAnalysis | null> {
        // Try direct SQL first
        const cached = await this.findCardCached(productId);
        if (cached) return cached;
        // Fall back to full analysis
        const result = await this.analyze();
        return result.all_cards.find(c => c.product_id === productId) ?? null;
    }

    /**
     * Non-blocking searchCards: uses direct SQL search for fast results.
     * Falls back to in-memory cache for advanced fuzzy matching.
     */
    async searchCardsCached(query: string, limit = 20): Promise<CardAnalysis[]> {
        if (!query || query.length < 2) return [];

        // Use SQL LIKE for fast initial results
        const sqlResults = db().searchAnalysis(query, limit * 2); // fetch extra for reranking
        if (sqlResults.length > 0) {
            // Build full CardAnalysis objects
            const cards: CardAnalysis[] = sqlResults.map(r => {
                const name = this.bulkNames.get(r.product_id) ?? r.product_name;
                return {
                    product_id: r.product_id,
                    product_name: name.startsWith("Product ") ? (this.bulkNames.get(r.product_id) ?? name) : name,
                    category: r.category,
                    group: r.group,
                    sub_type: r.sub_type,
                    date_range_start: "",
                    date_range_end: "",
                    total_days: 0,
                    activity_score: r.activity_score,
                    change_24h: r.change_24h,
                    change_30d: r.change_30d,
                    current_price: r.current_price,
                    min_price: 0,
                    max_price: 0,
                    mean_price: 0,
                    activity: null,
                };
            });
            // Apply the same fuzzy scoring/ranking used by searchCardsInResult
            const fakeResult: AnalysisResult = {
                metadata: {} as any,
                all_cards: cards,
                top_tradable: [],
                top_active: [],
            };
            return this.searchCardsInResult(fakeResult, query, limit);
        }

        // Fallback to in-memory cache
        const result = await this.getCached();
        if (!result) return [];
        return this.searchCardsInResult(result, query, limit);
    }

    async searchCards(query: string, limit = 20): Promise<CardAnalysis[]> {
        if (!query || query.length < 2) return [];
        const result = await this.analyze();
        return this.searchCardsInResult(result, query, limit);
    }

    private searchCardsInResult(result: AnalysisResult, query: string, limit: number): CardAnalysis[] {
        const qLower = query.toLowerCase().trim();
        const qWords = qLower.split(/\s+/);
        const qIsNum = /^\d+$/.test(qLower);
        const qInt = qIsNum ? parseInt(qLower, 10) : null;

        const scored: { score: number; card: CardAnalysis }[] = [];

        for (const card of result.all_cards) {
            let score = 0;
            if (qIsNum && qInt !== null) {
                const idStr = String(card.product_id);
                if (qInt === card.product_id) score = 100;
                else if (idStr.startsWith(qLower)) score = 90;
                else if (idStr.includes(qLower)) score = 70;
            }
            const name = card.product_name.toLowerCase();
            const isPlaceholder = name.startsWith("product ");
            if (!isPlaceholder) {
                if (qLower === name) score = Math.max(score, 100);
                else if (name.startsWith(qLower)) score = Math.max(score, 85);
                else if (name.includes(qLower)) score = Math.max(score, 65);
                else if (qWords.every(w => name.includes(w))) score = Math.max(score, 50);
                else if (qWords.some(w => w.length >= 3 && name.includes(w))) score = Math.max(score, 30);
            }
            const group = card.group.toLowerCase();
            if (group.includes(qLower)) score = Math.max(score, 40);
            else if (qWords.some(w => w.length >= 3 && group.includes(w))) score = Math.max(score, 25);
            if (card.sub_type.toLowerCase().includes(qLower)) score = Math.max(score, 35);
            if (score === 0 && !isPlaceholder && qLower.length >= 3) {
                let ni = 0, qi = 0;
                while (ni < name.length && qi < qLower.length) {
                    if (name[ni] === qLower[qi]) qi++;
                    ni++;
                }
                if (qi === qLower.length) score = 15 + (qLower.length / Math.max(1, ni)) * 10;
            }
            if (score > 0) {
                score += Math.min(card.activity_score / 10, 5);
                if (isPlaceholder) score *= 0.5;
                scored.push({ score, card });
            }
        }
        scored.sort((a, b) => b.score - a.score || a.card.product_id - b.card.product_id);
        return scored.slice(0, limit).map(s => s.card);
    }

    private enrichNames(result: AnalysisResult): AnalysisResult {
        if (this.bulkNames.size === 0) return result;
        const enrich = (cards: CardAnalysis[]) =>
            cards.map(c => {
                if (c.product_name.startsWith("Product ")) {
                    const real = this.bulkNames.get(c.product_id);
                    if (real) return { ...c, product_name: real };
                }
                return c;
            });
        return {
            metadata: result.metadata,
            all_cards: enrich(result.all_cards),
            top_tradable: enrich(result.top_tradable),
            top_active: enrich(result.top_active),
        };
    }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: CardAnalyzer | null = null;

export async function initAnalyzer(): Promise<CardAnalyzer> {
    if (!_instance) { _instance = new CardAnalyzer(); await _instance.init(); }
    return _instance;
}

export function analyzer(): CardAnalyzer {
    if (!_instance) throw new Error("CardAnalyzer not initialized — call initAnalyzer() first");
    return _instance;
}
