/**
 * Card routes — /api/cards
 *
 * Endpoints:
 *   GET /overview              top tradable cards by activity score
 *   GET /search?q=...          fuzzy search by name/ID
 *   GET /:id                   full card detail (product + pricing + analysis)
 *   GET /:id/bundle            detail with month + annual history
 *   GET /:id/product           product info + analysis only
 *   GET /:id/listings          marketplace listings
 *   GET /:id/sales             recent sales
 *   GET /:id/history           price history
 *   GET /:id/quick             instant cache-only + background fetch
 */

import { Elysia, t } from "elysia";
import { analyzer } from "../services/analyzer";
import { tcgplayer } from "../services/tcgplayer";
import { log } from "../log";
import type { ProductPricing, ProductInfo } from "../models";

const L = log("cards");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Merge cached ProductInfo + ProductPricing into a ProductDetails shape. */
function mergeDetails(info: ProductInfo, pricing: ProductPricing | null) {
    return {
        ...info,
        market_price: pricing?.market_price ?? null,
        lowest_price: pricing?.lowest_price ?? null,
        lowest_price_with_shipping: pricing?.lowest_price_with_shipping ?? null,
        median_price: pricing?.median_price ?? null,
        listings: pricing?.listings ?? 0,
        sellers: pricing?.sellers ?? 0,
    };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const cardsRoutes = new Elysia({ prefix: "/api/cards" })

    // ── GET /overview ────────────────────────────────────────────────────────
    .get(
        "/overview",
        async ({ query }) => {
            const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
            const force = query.force === "true";

            const ana = analyzer();
            // Only use blocking analyze() when force=true (admin action).
            // Normal requests use non-blocking cache to avoid stalling.
            const result = force ? await ana.analyze(true) : await ana.getCached();
            const topCards = result ? result.top_tradable.slice(0, limit) : [];

            // Enrich with live pricing from cache
            const client = tcgplayer();
            const enriched = await Promise.all(
                topCards.map(async (card) => {
                    const info = await client.getCachedProductInfoRaw(card.product_id);
                    const pricing = await client.getCachedPricingRaw(card.product_id);
                    return {
                        ...card,
                        // Override name from API if we have it and analyzer has placeholder
                        product_name: (card.product_name.startsWith("Product ") && info?.product_name)
                            ? info.product_name
                            : card.product_name,
                        // Attach live pricing
                        live_price: pricing?.market_price ?? pricing?.lowest_price ?? null,
                        market_price: pricing?.market_price ?? null,
                        lowest_price: pricing?.lowest_price ?? null,
                        image_url: info?.image_url ?? null,
                        tcgplayer_url: info?.url ?? null,
                        set_name: info?.set_name ?? "",
                        rarity_name: info?.rarity_name ?? "",
                    };
                }),
            );

            const emptyMetadata = {
                generated_at: new Date().toISOString(),
                total_cards_analyzed: 0,
                categories: [] as number[],
                rolling_window_days: 0,
                most_active_card: null,
                avg_activity_score: 0,
                median_activity_score: 0,
                high_activity_count: 0,
            };

            return {
                metadata: result ? result.metadata : emptyMetadata,
                top_tradable: enriched,
            };
        },
        {
            query: t.Object({
                limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
                force: t.Optional(t.String()),
            }),
            detail: {
                tags: ["Cards"],
                summary: "Get top tradable cards",
                description: "Returns top tradable cards ranked by activity score with live pricing data",
            },
        },
    )

    // ── GET /search ──────────────────────────────────────────────────────────
    .get(
        "/search",
        async ({ query }) => {
            const q = query.q;
            const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

            if (!q || q.length < 2) {
                return { query: q || "", results: [], count: 0 };
            }

            const ana = analyzer();
            const results = await ana.searchCardsCached(q, limit);

            // Enrich placeholder names from API cache
            const client = tcgplayer();
            const enriched = await Promise.all(
                results.map(async (card) => {
                    if (card.product_name.startsWith("Product ")) {
                        const info = await client.getCachedProductInfoRaw(card.product_id);
                        if (info?.product_name) {
                            return { ...card, product_name: info.product_name };
                        }
                    }
                    return card;
                }),
            );

            return {
                query: q,
                results: enriched,
                count: enriched.length,
            };
        },
        {
            query: t.Object({
                q: t.String({ minLength: 2, maxLength: 100 }),
                limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
            }),
            detail: {
                tags: ["Cards"],
                summary: "Search cards",
                description: "Fuzzy search Pokemon cards by name or ID",
            },
        },
    )

    // ── GET /:id — full card detail ──────────────────────────────────────────
    .get(
        "/:product_id",
        async ({ params }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { error: "Invalid product ID" };
            }

            const client = tcgplayer();
            const ana = analyzer();

            const [details, analysis, listings, sales, history] = await Promise.all([
                client.getProductDetails(productId),
                ana.findCardCached(productId),
                client.getListings(productId),
                client.getSales(productId),
                client.getHistory(productId),
            ]);

            if (!details) {
                return { error: `Card ${productId} not found` };
            }

            return {
                product: details,
                listings,
                recent_sales: sales,
                price_history: history,
                analysis,
            };
        },
        {
            params: t.Object({ product_id: t.String() }),
            detail: {
                tags: ["Cards"],
                summary: "Get card details",
                description: "Full card detail including product info, pricing, analysis, listings, sales, and price history",
            },
        },
    )

    // ── GET /:id/bundle — detail with both history ranges ────────────────────
    .get(
        "/:product_id/bundle",
        async ({ params, query }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { error: "Invalid product ID" };
            }

            const includeListings = query.include_listings !== "false";
            const includeSales = query.include_sales !== "false";
            const includeHistory = query.include_history !== "false";
            const forceRefresh = query.force_refresh === "true";

            const client = tcgplayer();
            const ana = analyzer();

            const [details, analysis, listings, sales, historyMonth, historyAnnual] = await Promise.all([
                client.getProductDetails(productId),
                ana.findCardCached(productId),
                includeListings ? client.getListings(productId, 50, forceRefresh) : Promise.resolve([]),
                includeSales ? client.getSales(productId, 25, forceRefresh) : Promise.resolve([]),
                includeHistory ? client.getHistory(productId, "month", forceRefresh) : Promise.resolve(null),
                includeHistory ? client.getHistory(productId, "annual", forceRefresh) : Promise.resolve(null),
            ]);

            if (!details) {
                return { error: `Card ${productId} not found` };
            }

            return {
                product: details,
                listings,
                recent_sales: sales,
                price_history: {
                    month: historyMonth,
                    annual: historyAnnual,
                },
                analysis,
            };
        },
        {
            params: t.Object({ product_id: t.String() }),
            query: t.Object({
                include_listings: t.Optional(t.String()),
                include_sales: t.Optional(t.String()),
                include_history: t.Optional(t.String()),
                force_refresh: t.Optional(t.String()),
            }),
            detail: {
                tags: ["Cards"],
                summary: "Get card bundle",
                description: "Card detail with month and annual price history. Use query params to include/exclude data.",
            },
        },
    )

    // ── GET /:id/product — product info + analysis only ──────────────────────
    .get(
        "/:product_id/product",
        async ({ params }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { error: "Invalid product ID" };
            }

            const client = tcgplayer();
            const ana = analyzer();

            const [details, analysis] = await Promise.all([
                client.getProductDetails(productId),
                ana.findCardCached(productId),
            ]);

            if (!details) {
                return { error: `Card ${productId} not found` };
            }

            return { product: details, analysis };
        },
        {
            params: t.Object({ product_id: t.String() }),
            detail: {
                tags: ["Cards"],
                summary: "Get product info",
                description: "Product info and analysis only (no listings/sales/history)",
            },
        },
    )

    // ── GET /:id/listings — marketplace listings ────────────────────────────
    .get(
        "/:product_id/listings",
        async ({ params, query }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { error: "Invalid product ID" };
            }

            const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
            const listings = await tcgplayer().getListings(productId, limit);

            return {
                product_id: productId,
                listings,
                count: listings.length,
            };
        },
        {
            params: t.Object({ product_id: t.String() }),
            query: t.Object({
                limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
            }),
            detail: {
                tags: ["Cards"],
                summary: "Get card listings",
                description: "Current marketplace listings for a card",
            },
        },
    )

    // ── GET /:id/sales — recent sales ───────────────────────────────────────
    .get(
        "/:product_id/sales",
        async ({ params, query }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { error: "Invalid product ID" };
            }

            const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
            const sales = await tcgplayer().getSales(productId, limit);

            return {
                product_id: productId,
                recent_sales: sales,
                count: sales.length,
            };
        },
        {
            params: t.Object({ product_id: t.String() }),
            query: t.Object({
                limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
            }),
            detail: {
                tags: ["Cards"],
                summary: "Get recent sales",
                description: "Recent sales history for a card",
            },
        },
    )

    // ── GET /:id/history — price history ────────────────────────────────────
    .get(
        "/:product_id/history",
        async ({ params, query }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { error: "Invalid product ID" };
            }

            const range = (query.range === "annual" ? "annual" : "month") as "month" | "annual";
            const history = await tcgplayer().getHistory(productId, range);

            return {
                product_id: productId,
                price_history: history,
            };
        },
        {
            params: t.Object({ product_id: t.String() }),
            query: t.Object({
                range: t.Optional(t.String()),
            }),
            detail: {
                tags: ["Cards"],
                summary: "Get price history",
                description: "Price history for a card (month or annual range)",
            },
        },
    )

    // ── GET /:id/quick — instant cache-only response ─────────────────────────
    .get(
        "/:product_id/quick",
        async ({ params }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { product: null, analysis: null, cached: false, fetching: false };
            }

            const client = tcgplayer();
            const ana = analyzer();

            // Only read from cache — never block on a live fetch
            const [cachedInfo, cachedPricing, analysis] = await Promise.all([
                client.getCachedProductInfoRaw(productId),
                client.getCachedPricingRaw(productId),
                ana.findCardCached(productId),
            ]);

            const hasInfo = cachedInfo !== null;
            const hasPricing = cachedPricing !== null;

            // If anything is missing, trigger a background fetch (fire & forget)
            if (!hasInfo || !hasPricing) {
                client.getProductDetails(productId).catch(e =>
                    L.debug(`Background details fetch failed for ${productId}: ${e instanceof Error ? e.message : e}`)
                );
            }

            if (cachedInfo) {
                return {
                    product: mergeDetails(cachedInfo, cachedPricing),
                    analysis,
                    cached: true,
                    fetching: !hasInfo || !hasPricing,
                };
            }

            // Nothing cached at all
            return {
                product: null,
                analysis,
                cached: false,
                fetching: true,
            };
        },
        {
            params: t.Object({ product_id: t.String() }),
            detail: {
                tags: ["Cards"],
                summary: "Quick card lookup",
                description: "Instant cache-only response with background fetch for missing data",
            },
        },
    )

    // ══════════════════════════════════════════════════════════════════════════
    // AI AGENT OPTIMIZED ENDPOINTS
    // ══════════════════════════════════════════════════════════════════════════

    // ── POST /batch — fetch multiple cards in one call ───────────────────────
    .post(
        "/batch",
        async ({ body }) => {
            const { productIds, include } = body;
            
            if (!productIds || productIds.length === 0) {
                return { cards: [], count: 0 };
            }
            if (productIds.length > 50) {
                return { error: "Maximum 50 product IDs per batch request" };
            }

            const includeAnalysis = include?.includes("analysis") ?? true;
            const includeListings = include?.includes("listings") ?? false;
            const includeSales = include?.includes("sales") ?? false;
            const includeHistory = include?.includes("history") ?? false;

            const client = tcgplayer();
            const ana = analyzer();

            // Fetch all data in parallel
            const results = await Promise.all(
                productIds.map(async (productId) => {
                    const [details, analysis, listings, sales, history] = await Promise.all([
                        client.getProductDetails(productId),
                        includeAnalysis ? ana.findCardCached(productId) : Promise.resolve(null),
                        includeListings ? client.getListings(productId, 20) : Promise.resolve([]),
                        includeSales ? client.getSales(productId, 10) : Promise.resolve([]),
                        includeHistory ? client.getHistory(productId, "month") : Promise.resolve(null),
                    ]);

                    if (!details) {
                        return { productId, found: false };
                    }

                    return {
                        productId,
                        found: true,
                        product: details,
                        analysis: includeAnalysis ? analysis : undefined,
                        listings: includeListings ? listings : undefined,
                        recentSales: includeSales ? sales : undefined,
                        priceHistory: includeHistory ? history : undefined,
                    };
                })
            );

            const found = results.filter(r => r.found);
            const notFound = results.filter(r => !r.found).map(r => r.productId);

            return {
                cards: found,
                count: found.length,
                notFound: notFound.length > 0 ? notFound : undefined,
            };
        },
        {
            body: t.Object({
                productIds: t.Array(t.Number(), { minItems: 1, maxItems: 50 }),
                include: t.Optional(t.Array(t.String())),
            }),
            detail: {
                tags: ["Cards"],
                summary: "Batch fetch multiple cards",
                description: "Fetch data for up to 50 cards in a single request. Use 'include' to specify what data to fetch: analysis, listings, sales, history. Optimized for AI agents.",
            },
        },
    )

    // ── GET /:id/signals — trading signals for a card ────────────────────────
    .get(
        "/:product_id/signals",
        async ({ params }) => {
            const productId = parseInt(params.product_id, 10);
            if (!Number.isFinite(productId) || productId <= 0) {
                return { error: "Invalid product ID" };
            }

            const client = tcgplayer();
            const ana = analyzer();

            const [details, analysis, history, listings] = await Promise.all([
                client.getProductDetails(productId),
                ana.findCardCached(productId),
                client.getHistory(productId, "month"),
                client.getListings(productId, 50),
            ]);

            if (!details || !analysis) {
                return { error: "Card not found or not analyzed" };
            }

            // Calculate momentum signal
            let momentumScore = 0;
            let momentumDirection: "increasing" | "decreasing" | "neutral" = "neutral";
            if (history && history.prices.length >= 7) {
                const prices = history.prices.slice(-7); // Last 7 days
                const recent = prices.slice(-3).reduce((a, b) => a + b, 0) / 3;
                const earlier = prices.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
                if (earlier > 0) {
                    const change = (recent - earlier) / earlier;
                    momentumScore = Math.min(Math.max(change * 5, -1), 1); // Scale to -1 to 1
                    momentumDirection = change > 0.02 ? "increasing" : change < -0.02 ? "decreasing" : "neutral";
                }
            }

            // Calculate mean reversion signal
            let zScore = 0;
            let meanReversionSignal: "oversold" | "overbought" | "neutral" = "neutral";
            if (analysis.mean_price && analysis.current_price) {
                const mean = analysis.mean_price;
                const current = analysis.current_price;
                const stdDev = (analysis.max_price - analysis.min_price) / 4; // Approximate
                if (stdDev > 0) {
                    zScore = (current - mean) / stdDev;
                    meanReversionSignal = zScore > 1.5 ? "overbought" : zScore < -1.5 ? "oversold" : "neutral";
                }
            }

            // Supply pressure signal
            let supplySignal: "bullish" | "bearish" | "neutral" = "neutral";
            const listingCount = listings.length;
            if (listingCount < 20) {
                supplySignal = "bullish"; // Low supply
            } else if (listingCount > 80) {
                supplySignal = "bearish"; // High supply
            }

            // Activity signal
            let activitySignal: "high" | "medium" | "low" = "low";
            if (analysis.activity_score >= 70) {
                activitySignal = "high";
            } else if (analysis.activity_score >= 40) {
                activitySignal = "medium";
            }

            // Composite recommendation
            const bullishFactors: string[] = [];
            const bearishFactors: string[] = [];

            if (momentumDirection === "increasing") bullishFactors.push("Positive momentum");
            if (momentumDirection === "decreasing") bearishFactors.push("Negative momentum");
            if (meanReversionSignal === "oversold") bullishFactors.push("Oversold (mean reversion opportunity)");
            if (meanReversionSignal === "overbought") bearishFactors.push("Overbought (mean reversion risk)");
            if (supplySignal === "bullish") bullishFactors.push("Low supply pressure");
            if (supplySignal === "bearish") bearishFactors.push("High supply pressure");
            if (analysis.change_24h > 3) bullishFactors.push("Strong 24h gain");
            if (analysis.change_24h < -3) bearishFactors.push("Strong 24h loss");
            if (activitySignal === "high") bullishFactors.push("High trading activity");

            const bullishScore = bullishFactors.length;
            const bearishScore = bearishFactors.length;
            
            let recommendation: "long" | "short" | "neutral" = "neutral";
            let confidence = 0;
            if (bullishScore > bearishScore + 1) {
                recommendation = "long";
                confidence = Math.min((bullishScore - bearishScore) / 5, 1);
            } else if (bearishScore > bullishScore + 1) {
                recommendation = "short";
                confidence = Math.min((bearishScore - bullishScore) / 5, 1);
            }

            // Suggested leverage based on volatility
            const volatilityRange = analysis.max_price - analysis.min_price;
            const volatilityPercent = analysis.mean_price > 0 ? (volatilityRange / analysis.mean_price) * 100 : 50;
            let suggestedLeverage = 10;
            if (volatilityPercent > 50) suggestedLeverage = 3;
            else if (volatilityPercent > 30) suggestedLeverage = 5;
            else if (volatilityPercent > 15) suggestedLeverage = 10;
            else suggestedLeverage = 15;

            // Risk level
            let riskLevel: "low" | "medium" | "high" = "medium";
            if (volatilityPercent > 40 || listingCount < 10) {
                riskLevel = "high";
            } else if (volatilityPercent < 20 && listingCount > 30) {
                riskLevel = "low";
            }

            return {
                productId,
                productName: details.product_name,
                currentPrice: analysis.current_price,
                signals: {
                    momentum: {
                        score: Math.round(momentumScore * 100) / 100,
                        direction: momentumDirection,
                    },
                    meanReversion: {
                        zScore: Math.round(zScore * 100) / 100,
                        signal: meanReversionSignal,
                    },
                    supply: {
                        listingCount,
                        signal: supplySignal,
                    },
                    activity: {
                        score: analysis.activity_score,
                        signal: activitySignal,
                    },
                    priceChange: {
                        change24h: analysis.change_24h,
                        change30d: analysis.change_30d,
                    },
                },
                recommendation: {
                    action: recommendation,
                    confidence: Math.round(confidence * 100) / 100,
                    suggestedLeverage,
                    riskLevel,
                    bullishFactors,
                    bearishFactors,
                },
                priceRange: {
                    min: analysis.min_price,
                    max: analysis.max_price,
                    mean: analysis.mean_price,
                    current: analysis.current_price,
                },
            };
        },
        {
            params: t.Object({ product_id: t.String() }),
            detail: {
                tags: ["Cards"],
                summary: "Get trading signals for a card",
                description: "Returns pre-computed trading signals including momentum, mean reversion, supply pressure, and a composite recommendation. Optimized for AI agents.",
            },
        },
    );
