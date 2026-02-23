/**
 * Card analysis & perp suitability scoring types.
 *
 * Seven-criterion scoring for perpetual trading suitability:
 *
 *   1. Oracle Reliability   (25%) — data availability, staleness, price source agreement
 *   2. Market Depth         (20%) — listings, sellers, spread tightness
 *   3. Transaction Volume   (18%) — recent sales, daily transaction volume
 *   4. Price Level          (12%) — minimum viable price for leverage trading
 *   5. Volatility Character (10%) — continuous movement (good) vs gap risk (bad)
 *   6. Manipulation Resist. (10%) — seller concentration, cost to move price
 *   7. Demand Persistence    (5%) — data longevity, volume trend
 *
 * All sub-scores are 0-100. The composite `perp_score` is the weighted sum.
 * The old `activity_score` field is an alias for `perp_score` for backward compat.
 */

export interface PerpMetrics {
    perp_score: number;          // composite 0-100 (= activity_score)

    // ── 1. Oracle Reliability (25%) ──
    oracle_score: number;        // 0-100
    data_availability: number;   // fraction of days with valid prices (0-1)
    staleness_days: number;      // consecutive identical prices at tail of series
    price_source_agreement: number; // 0-1: how well archive, live, and sale prices agree

    // ── 2. Market Depth (20%) ──
    depth_score: number;         // 0-100
    listing_count: number;       // raw listing count
    seller_count: number;        // raw unique seller count
    spread_tightness: number;    // 1 - (market - lowest) / market

    // ── 3. Transaction Volume (18%) ──
    volume_score: number;        // 0-100
    sales_7d: number;            // quantity sold in last 7 days
    sales_30d: number;           // quantity sold in last 30 days
    avg_daily_volume: number;    // from price history buckets

    // ── 4. Price Level (12%) ──
    price_score: number;         // 0-100
    current_price: number;       // latest archive price (USD)

    // ── 5. Volatility Character (10%) ──
    volatility_score: number;    // 0-100 (penalizes gap moves)
    daily_change_avg: number;    // mean abs daily % change
    change_frequency: number;    // fraction of days with >0.1% change
    max_single_day_move: number; // worst single-day % move (gap risk)

    // ── 6. Manipulation Resistance (10%) ──
    manipulation_score: number;  // 0-100
    seller_hhi: number;          // Herfindahl index from listings (0-1, lower=better)
    depth_near_market: number;   // # listings within 15% of lowest price

    // ── 7. Demand Persistence (5%) ──
    persistence_score: number;   // 0-100
    valid_days: number;          // total days of valid data in archive
    volume_trend: number;        // weekly vs monthly pace ratio (>0.7 = stable)
}

export interface CardAnalysis {
    product_id: number;
    product_name: string;
    category: number;
    group: string;
    sub_type: string;
    date_range_start: string;
    date_range_end: string;
    total_days: number;

    /** Composite perp suitability score 0-100. */
    activity_score: number;

    /** Change from the price ~1 calendar day ago. */
    change_24h: number;
    /** Change from the price ~30 calendar days ago. */
    change_30d: number;

    current_price: number;
    min_price: number;
    max_price: number;
    mean_price: number;

    /** Full scoring breakdown. Null only if card didn't pass filters. */
    activity: PerpMetrics | null;
}

export interface AnalysisSummary {
    generated_at: string;
    total_cards_analyzed: number;
    categories: number[];
    rolling_window_days: number;
    most_active_card: string | null;
    avg_activity_score: number;
    median_activity_score: number;
    high_activity_count: number;
}

export interface AnalysisResult {
    metadata: AnalysisSummary;
    all_cards: CardAnalysis[];
    top_tradable: CardAnalysis[];
    top_active: CardAnalysis[];
}
