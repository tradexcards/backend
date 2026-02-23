/**
 * Dashboard routes — /api/dashboard
 *
 * Endpoints:
 *   GET /                JSON overview: top products with analysis + volume-sorted tradable IDs
 *   GET /bundles         Bulk card bundles (product + analysis + month history)
 *   GET /monitor         Self-contained HTML dashboard (auto-refreshes every 2s)
 *   GET /monitor/data    JSON data powering the HTML monitor
 */

import { Elysia, t } from "elysia";
import { env, readActiveProductIds } from "../env";
import { analyzer } from "../services/analyzer";
import { tcgplayer } from "../services/tcgplayer";
import { tcgcsv } from "../services/tcgcsv";
import { loops } from "../services/loops";
import { keeper } from "../services/oracle/keeper";
import { perpdex } from "../services/perpdex";
import { db } from "../services/db";
import { getClientCount as getWsClientCount } from "./ws";
import type { ProductPricing, ProductInfo } from "../models";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Merge cached ProductInfo + ProductPricing into a ProductDetails-like shape. */
function mergeProductDetails(info: ProductInfo, pricing: ProductPricing | null) {
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

function pricingAgeSeconds(pricing: ProductPricing): number | null {
    if (!pricing?.fetched_at) return null;
    const ts = new Date(pricing.fetched_at).getTime();
    if (!Number.isFinite(ts)) return null;
    return (Date.now() - ts) / 1000;
}

function pickPrice(pricing: ProductPricing): number | null {
    const p = pricing.market_price || pricing.lowest_price || 0;
    return Number.isFinite(p) && p > 0 ? p : null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const dashboardRoutes = new Elysia({ prefix: "/api/dashboard" })

    // ── GET / — JSON overview ────────────────────────────────────────────────
    .get(
        "/",
        async ({ query }) => {
            const cfg = env();
            const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);

            const ana = analyzer();
            const client = tcgplayer();

            // Filter to active product set (respects active.txt)
            // Use all_cards (not top_tradable) so every active ID is included
            // regardless of its activity-score ranking.
            const activeIds = new Set(readActiveProductIds(limit));

            // NON-BLOCKING: return cached analysis instantly. Never trigger a
            // multi-minute analysis run in the request path. If no cache exists
            // yet (cold boot), return a degraded response with empty cards.
            const result = await ana.getCached();
            const topCards = result
                ? result.all_cards
                    .filter(c => activeIds.has(c.product_id))
                    .slice(0, limit)
                : [];

            // Enrich cards: replace placeholder names from API cache
            const enriched = await Promise.all(
                topCards.map(async (card) => {
                    if (card.product_name.startsWith("Product ")) {
                        const info = await client.getCachedProductInfoRaw(card.product_id);
                        if (info?.product_name) return { ...card, product_name: info.product_name };
                    }
                    return card;
                }),
            );

            // Build tradable_ids: top products that have fresh pricing with a valid price
            const maxAge = cfg.cache.pricing;
            const pricingResults = await Promise.all(
                enriched.map(async (card) => {
                    const pricing = await client.getCachedPricingRaw(card.product_id);
                    return { productId: card.product_id, pricing };
                }),
            );
            const tradableIds: number[] = [];
            for (const { productId, pricing } of pricingResults) {
                if (!pricing) continue;
                const age = pricingAgeSeconds(pricing);
                if (age !== null && age <= maxAge && pickPrice(pricing) !== null) {
                    tradableIds.push(productId);
                }
            }

            // Sort tradable_ids by on-chain volume (descending) using the cached market stats.
            // This lets the frontend render the list in volume order without needing
            // a separate bulk RPC call for every card.
            const svc = perpdex();
            const statsCache = svc.getCachedMarketStats();
            const tradableSet = new Set(tradableIds);

            let sortedTradableIds: number[];

            if (statsCache.size > 0) {
                // Build sorted list: volume-sorted cached IDs first, then remaining tradable IDs
                const volumeSorted = svc.getProductIdsSortedByVolume();
                const seen = new Set<number>();
                sortedTradableIds = [];

                for (const id of volumeSorted) {
                    if (tradableSet.has(id)) {
                        sortedTradableIds.push(id);
                        seen.add(id);
                    }
                }
                // Append any tradable IDs not in the cache (new markets, etc.)
                for (const id of tradableIds) {
                    if (!seen.has(id)) {
                        sortedTradableIds.push(id);
                    }
                }
            } else {
                sortedTradableIds = tradableIds;
            }

            const emptyMetadata = {
                generated_at: new Date().toISOString(),
                total_cards_analyzed: 0,
                categories: [...cfg.analysis.categories],
                rolling_window_days: cfg.analysis.rollingWindowDays,
                most_active_card: null,
                avg_activity_score: 0,
                median_activity_score: 0,
                high_activity_count: 0,
            };

            // Compute the biggest positive 24h mover across ALL active
            // cards (full active.txt set), not just the `limit`-sliced subset
            // we return in top_tradable.
            const allActiveIds = new Set(readActiveProductIds(200));
            let biggestMover: { product_id: number; product_name: string; change_24h: number } | null = null;
            if (result) {
                for (const card of result.all_cards) {
                    if (!allActiveIds.has(card.product_id)) continue;
                    if (card.change_24h > 0 && (!biggestMover || card.change_24h > biggestMover.change_24h)) {
                        biggestMover = {
                            product_id: card.product_id,
                            product_name: card.product_name,
                            change_24h: card.change_24h,
                        };
                    }
                }
            }

            return {
                overview: {
                    metadata: result ? result.metadata : emptyMetadata,
                    top_tradable: enriched,
                },
                biggest_mover: biggestMover,
                tradable_ids: sortedTradableIds,
            };
        },
        {
            query: t.Object({
                limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
            }),
            detail: {
                tags: ["Dashboard"],
                summary: "Dashboard overview",
                description: "Top products with analysis, volume-sorted tradable IDs, and biggest mover",
            },
        },
    )

    // ── GET /bundles — Bulk card bundles for all tradable products ───────────
    // Returns product details, listings, recent sales, and price histories
    // for every tradable card in a single response. All data comes from the
    // backend's already-warmed caches so this is essentially free.
    .get(
        "/bundles",
        async ({ query }) => {
            const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
            const offset = Math.max(query.offset ?? 0, 0);
            const client = tcgplayer();
            const ana = analyzer();

            // Read full active set then slice the requested window
            const allActiveIds = readActiveProductIds(200);
            const totalCount = allActiveIds.length;
            const activeIds = allActiveIds.slice(offset, offset + limit);
            if (activeIds.length === 0) {
                return { bundles: {}, count: 0, total: totalCount, offset, limit };
            }

            // Build lightweight bundles: product + analysis + month history only.
            // Listings, sales, and annual history are fetched per-card on selection
            // via useCardBundle (which polls every 60s for the active card).
            // We also strip the heavy `skus[]` array from price history — the
            // frontend only uses the flattened `dates[]`/`prices[]`.
            const bundles: Record<number, {
                product: ReturnType<typeof mergeProductDetails> | null;
                price_history: {
                    month: { product_id: number; range_type: string; dates: string[]; prices: number[] } | null;
                };
                analysis: any | null;
            }> = {};

            await Promise.all(
                activeIds.map(async (productId) => {
                    const [info, pricing, histMonth, analysis] =
                        await Promise.all([
                            client.getCachedProductInfoRaw(productId),
                            client.getCachedPricingRaw(productId),
                            client.getCachedHistoryRaw(productId, "month"),
                            ana.findCardCached(productId),
                        ]);

                    // Only include if we have at least product info
                    if (!info) return;

                    bundles[productId] = {
                        product: mergeProductDetails(info, pricing),
                        price_history: {
                            // Strip skus[] — frontend only reads dates/prices
                            month: histMonth ? {
                                product_id: histMonth.product_id,
                                range_type: histMonth.range_type,
                                dates: histMonth.dates,
                                prices: histMonth.prices,
                            } : null,
                        },
                        analysis: analysis ?? null,
                    };
                }),
            );

            return {
                bundles,
                count: Object.keys(bundles).length,
                total: totalCount,
                offset,
                limit,
            };
        },
        {
            query: t.Object({
                limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
                offset: t.Optional(t.Numeric({ minimum: 0 })),
            }),
            detail: {
                tags: ["Dashboard"],
                summary: "Get card bundles",
                description: "Bulk card bundles (product + analysis + price history) for tradable cards",
            },
        },
    )

    // ── GET /explore — Paginated list of ALL analyzed cards (not just active) ─
    // Used by the explore page to browse the full card database.
    // Returns trending (active) cards first, then the rest sorted by activity score.
    .get(
        "/explore",
        async ({ query }) => {
            const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
            const offset = Math.max(query.offset ?? 0, 0);
            const client = tcgplayer();
            const ana = analyzer();

            // Get ALL analyzed cards (not filtered by active.txt)
            const result = await ana.getCached();
            if (!result) {
                return { bundles: {}, count: 0, total: 0, offset, limit };
            }

            // Get active/trending product IDs
            const activeIds = new Set(readActiveProductIds(200));

            // Additional filter for non-card products that may have slipped through
            // the analyzer's initial filter (based on product_type_name and name patterns)
            const NON_CARD_PATTERNS = /\b(booster\s*(box|pack|bundle)|elite\s*trainer\s*box|etb|blister|tin[s]?\b|collection\s*(box)?|display|case\b|build\s*&?\s*battle|poster|binder|sleeves|deck\s*box|playmat|album|storage|protectors|premium\s*(box|collection)|special\s*(box|set)|sticker|lunch\s*box|collector('?s)?\s*(chest|box|tin)|pokemon\s*center|figure|plush|pin\b|coin\b|promo\s*(pack|cards?\s*bundle)|celebrations|anniversary\s*(box|set|collection)|golden\s*box|set\s*of\s*\d+|ultra\s*premium|treasure\s*chest|mini\s*(tin|album|binder)|trainer\s*gallery|poke\s*ball|card\s*game|lunchbox|sam'?s\s*club|costco|walmart\s*exclusive|target\s*exclusive|\d+\s*(mini\s*)?tins?|\d+\s*packs?|bundle\)?$|sealed|japanese\s*(box|booster|pack))\b/i;
            
            const filteredCards = result.all_cards.filter(card => {
                // Filter out products with non-card names
                if (NON_CARD_PATTERNS.test(card.product_name)) {
                    return false;
                }
                return true;
            });
            
            // Sort: trending (active) cards first, then by activity score
            const allCards = filteredCards.sort((a, b) => {
                const aActive = activeIds.has(a.product_id);
                const bActive = activeIds.has(b.product_id);
                // Trending cards first
                if (aActive && !bActive) return -1;
                if (!aActive && bActive) return 1;
                // Then by activity score
                const aScore = a.activity_score ?? 0;
                const bScore = b.activity_score ?? 0;
                return bScore - aScore;
            });
            
            const totalCount = allCards.length;
            const pageCards = allCards.slice(offset, offset + limit);

            if (pageCards.length === 0) {
                return { bundles: {}, count: 0, total: totalCount, offset, limit };
            }

            // Batch fetch all data in 3 queries instead of 300 individual queries
            const productIds = pageCards.map(c => c.product_id);
            const [productsMap, pricingsMap, historyMap] = [
                client.getCachedProductsBatch(productIds),
                client.getCachedPricingsBatch(productIds),
                client.getCachedHistoryBatch(productIds, "month"),
            ];

            // Build lightweight bundles for each card
            const bundles: Record<number, {
                product: any;
                price_history: {
                    month: { product_id: number; range_type: string; dates: string[]; prices: number[] } | null;
                };
                analysis: any | null;
                is_trending: boolean;
            }> = {};

            for (const card of pageCards) {
                const productId = card.product_id;
                const info = productsMap.get(productId) ?? null;
                const pricing = pricingsMap.get(productId) ?? null;
                const histMonth = historyMap.get(productId) ?? null;

                // Skip if product_type_name indicates it's not a card
                if (info && info.product_type_name && info.product_type_name !== "Cards") {
                    continue;
                }

                // Build product info from cache or fallback to analysis data
                const product = info
                    ? mergeProductDetails(info, pricing)
                    : {
                        product_id: productId,
                        product_name: card.product_name,
                        set_name: "",
                        set_code: "",
                        rarity_name: "",
                        product_type_name: "Cards",
                        product_line_name: "",
                        image_url: `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`,
                        url: `https://www.tcgplayer.com/product/${productId}`,
                        market_price: card.current_price,
                        lowest_price: null,
                        lowest_price_with_shipping: null,
                        median_price: null,
                        listings: 0,
                        sellers: 0,
                        skus: [],
                    };

                bundles[productId] = {
                    product,
                    price_history: {
                        month: histMonth ? {
                            product_id: histMonth.product_id,
                            range_type: histMonth.range_type,
                            dates: histMonth.dates,
                            prices: histMonth.prices,
                        } : null,
                    },
                    analysis: card,
                    is_trending: activeIds.has(productId),
                };
            }

            return {
                bundles,
                count: Object.keys(bundles).length,
                total: totalCount,
                offset,
                limit,
            };
        },
        {
            query: t.Object({
                limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
                offset: t.Optional(t.Numeric({ minimum: 0 })),
            }),
            detail: {
                tags: ["Dashboard"],
                summary: "Explore all cards",
                description: "Paginated list of all analyzed cards with trending cards first",
            },
        },
    )

    // ── GET /monitor/data — JSON for the HTML monitor ────────────────────────
    .get("/monitor/data", async () => {
        const cfg = env();
        const client = tcgplayer();
        const csv = tcgcsv();
        const ana = analyzer();

        // Read ALL active IDs — every one must appear in the monitor
        const allActiveIds = readActiveProductIds(200);
        const activeIds = new Set(allActiveIds);

        // NON-BLOCKING: use cached analysis (never block on fresh analysis)
        const result = await ana.getCached();
        // Build analysis lookup (some IDs may not have analysis data)
        const analysisMap = new Map<number, any>();
        if (result) {
            for (const card of result.all_cards) {
                if (activeIds.has(card.product_id)) {
                    analysisMap.set(card.product_id, card);
                }
            }
        }

        // Get all ER-published prices from the keeper (in-memory, no RPC)
        const k = keeper();
        const erPrices = k ? k.getAllErPrices() : new Map<number, { priceUsd: number; publishedAt: number }>();

        const maxAge = cfg.cache.pricing;

        // Fetch cached pricing + info for ALL active products
        const rows = await Promise.all(
            allActiveIds.map(async (productId) => {
                const pricing = await client.getCachedPricingRaw(productId);
                const info = await client.getCachedProductInfoRaw(productId);
                const card = analysisMap.get(productId);

                const age = pricing ? pricingAgeSeconds(pricing) : null;
                const price = pricing ? pickPrice(pricing) : null;

                // Determine pricing status
                let status: "fresh" | "stale" | "missing" = "missing";
                if (pricing && age !== null) {
                    status = age <= maxAge ? "fresh" : "stale";
                }

                // Determine tradability and reason for being inactive
                let tradable = true;
                let inactive_reason: string | null = null;

                if (!card) {
                    tradable = false;
                    inactive_reason = "No analysis data (not enough archive history or missing from TCGCSV)";
                } else if (!pricing) {
                    tradable = false;
                    inactive_reason = "No cached pricing";
                } else if (age === null) {
                    tradable = false;
                    inactive_reason = "Pricing has no timestamp";
                } else if (age > maxAge) {
                    tradable = false;
                    inactive_reason = `Pricing stale (${Math.round(age)}s > ${maxAge}s max)`;
                } else if (price === null) {
                    tradable = false;
                    inactive_reason = "Zero price (market_price=0, lowest_price=0)";
                }

                // ER on-chain price
                const er = erPrices.get(productId);
                const erPrice = er?.priceUsd ?? null;
                const erPublishedAt = er?.publishedAt ?? null;
                const erAgeSeconds = erPublishedAt !== null ? Math.round((Date.now() - erPublishedAt) / 1000) : null;

                // Difference: positive = ER price is higher than backend live price
                let erDiffPct: number | null = null;
                if (price !== null && erPrice !== null && price > 0) {
                    erDiffPct = ((erPrice - price) / price) * 100;
                }

                return {
                    product_id: productId,
                    product_name: info?.product_name ?? card?.product_name ?? `Product ${productId}`,
                    set_name: info?.set_name ?? "",
                    rarity_name: info?.rarity_name ?? "",
                    image_url: info?.image_url ?? null,
                    tcgplayer_url: info?.url ?? null,
                    activity_score: card?.activity_score ?? 0,
                    current_price_archive: card?.current_price ?? null,
                    change_24h: card?.change_24h ?? 0,
                    change_30d: card?.change_30d ?? 0,
                    live_price: price,
                    market_price: pricing?.market_price ?? null,
                    median_price: pricing?.median_price ?? null,
                    listings: pricing?.listings ?? 0,
                    sellers: pricing?.sellers ?? 0,
                    fetched_at: pricing?.fetched_at ?? null,
                    age_seconds: age !== null ? Math.round(age) : null,
                    status,
                    tradable,
                    inactive_reason,
                    er_price: erPrice,
                    er_age_seconds: erAgeSeconds,
                    er_diff_pct: erDiffPct,
                };
            }),
        );

        const totals = rows.reduce(
            (acc, r) => {
                if (r.status === "fresh") acc.fresh++;
                else if (r.status === "stale") acc.stale++;
                else acc.missing++;
                if (!r.tradable) acc.inactive++;
                return acc;
            },
            { fresh: 0, stale: 0, missing: 0, inactive: 0 },
        );

        const dates = csv.getAvailableDates();

        // Activation requests
        const pendingActivationCount = db().countPendingActivationRequests();
        const activationRequests = db().getActivationRequestsSummary({ status: "pending", limit: 50 });

        // Exchange state (fees, etc.)
        const exchangeState = await perpdex().getExchangeState();
        const feesCollected = exchangeState?.totalFeesCollected ?? 0;
        const totalDeposits = exchangeState?.totalDeposits ?? 0;

        // Get keeper info for treasury display
        const keeperInstance = keeper();
        const treasuryWallet = keeperInstance ? keeperInstance.getTreasuryWallet().toBase58() : null;

        return {
            timestamp: Date.now(),
            total: rows.length,
            max_price_age_seconds: maxAge,
            totals,
            loops: loops().getStatus(),
            proxy_enabled: client.isProxyEnabled,
            cache: client.getCacheStats(),
            ws_clients: getWsClientCount(),
            data: {
                available_dates: dates.length,
                oldest_date: dates[0] ?? null,
                newest_date: dates[dates.length - 1] ?? null,
                total_analyzed: result?.metadata.total_cards_analyzed ?? 0,
            },
            activation_requests: {
                pending_count: pendingActivationCount,
                requests: activationRequests,
            },
            exchange: {
                totalFeesCollected: feesCollected,
                totalDeposits,
                treasuryWallet,
            },
            rows,
        };
    }, {
        detail: {
            tags: ["Dashboard"],
            summary: "Monitor data",
            description: "JSON data for the HTML monitor dashboard",
        },
    })

    // ── GET /monitor — Self-contained HTML dashboard ─────────────────────────
    .get("/monitor", () => {
        return new Response(MONITOR_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    }, {
        detail: {
            tags: ["Dashboard"],
            summary: "Monitor HTML",
            description: "Self-contained HTML dashboard with auto-refresh",
        },
    });

// ── Monitor HTML ────────────────────────────────────────────────────────────

const MONITOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TradeX — Price Monitor</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; font-size: 13px; background: var(--bg); color: var(--text); padding: 16px; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); margin-bottom: 16px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .fresh { color: var(--green); }
  .stale { color: var(--yellow); }
  .missing { color: var(--red); }
  .loops { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .loop-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .loop-name { font-weight: 600; margin-bottom: 4px; }
  .loop-meta { color: var(--muted); font-size: 11px; }
  .loop-state { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .loop-state.idle { background: #1f2d1f; color: var(--green); }
  .loop-state.running { background: #2d2a1f; color: var(--yellow); }
  .loop-state.paused { background: #2d1f1f; color: var(--red); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  thead { background: #1c2128; }
  th { text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); }
  td { padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #1c2128; }
  tr.er-up { background: rgba(63, 185, 80, 0.08); }
  tr.er-down { background: rgba(248, 81, 73, 0.08); }
  tr.er-up:hover { background: rgba(63, 185, 80, 0.15); }
  tr.er-down:hover { background: rgba(248, 81, 73, 0.15); }
  .price { font-weight: 600; font-variant-numeric: tabular-nums; }
  .change-pos { color: var(--green); }
  .change-neg { color: var(--red); }
  .change-zero { color: var(--muted); }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .badge-fresh { background: #1f2d1f; color: var(--green); }
  .badge-stale { background: #2d2a1f; color: var(--yellow); }
  .badge-missing { background: #2d1f1f; color: var(--red); }
  .badge-active { background: #1f2d1f; color: var(--green); }
  .badge-inactive { background: #2d1f1f; color: var(--red); }
  tr.inactive-row { opacity: 0.55; }
  tr.inactive-row:hover { opacity: 0.85; }
  .reason { font-size: 10px; color: var(--muted); max-width: 200px; white-space: normal; line-height: 1.3; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .activation-section { margin-bottom: 16px; }
  .activation-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .activation-title { font-size: 14px; font-weight: 600; }
  .activation-count { background: var(--yellow); color: #000; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
  .act-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .act-info { flex: 1; }
  .act-product { font-weight: 600; font-size: 13px; }
  .act-meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .act-wallets { color: var(--muted); font-size: 11px; margin-top: 4px; word-break: break-all; }
  .act-actions { display: flex; gap: 6px; margin-left: 12px; }
  .act-btn { padding: 4px 12px; border-radius: 4px; border: none; font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit; }
  .act-btn-approve { background: var(--green); color: #000; }
  .act-btn-approve:hover { opacity: 0.85; }
  .act-btn-reject { background: var(--red); color: #fff; }
  .act-btn-reject:hover { opacity: 0.85; }
  .act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .act-empty { color: var(--muted); font-size: 12px; padding: 16px; text-align: center; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
  .admin-auth { margin-bottom: 16px; display: flex; gap: 8px; align-items: center; }
  .admin-auth input { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; color: var(--text); font-family: inherit; font-size: 12px; width: 240px; }
  .admin-auth label { color: var(--muted); font-size: 11px; }
  .refresh-indicator { position: fixed; top: 8px; right: 16px; color: var(--muted); font-size: 11px; }
  .img-thumb { width: 28px; height: 28px; object-fit: contain; border-radius: 3px; vertical-align: middle; margin-right: 6px; }
  .product-cell { display: flex; align-items: center; }
  .product-name { overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  .set-name { color: var(--muted); font-size: 11px; }
</style>
</head>
<body>

<h1>TradeX — Price Monitor</h1>
<div class="subtitle" id="subtitle">Loading...</div>
<div class="refresh-indicator" id="refresh">--</div>

<div class="grid" id="stats"></div>
<div class="loops" id="loops"></div>

<div class="activation-section" id="activation-section">
  <div class="activation-header">
    <div class="activation-title">Activation Requests</div>
    <span class="activation-count" id="activation-count">0</span>
  </div>
  <div class="admin-auth">
    <label>Admin Key:</label>
    <input type="password" id="admin-key" placeholder="Enter admin password to approve/reject" autocomplete="off">
  </div>
  <div id="activation-list"></div>
</div>

<div class="activation-section" id="fees-section">
  <div class="activation-header">
    <div class="activation-title">Protocol Fees</div>
  </div>
  <div class="act-card">
    <div class="act-info">
      <div class="act-product">Total Deposits: <span id="total-deposits">$0.00</span></div>
      <div class="act-meta">Withdrawable Fees: <span id="fees-collected" style="color: var(--green); font-weight: 600;">$0.00</span></div>
      <div class="act-wallets">Treasury: <span id="treasury-wallet">—</span></div>
    </div>
    <div class="act-actions" style="flex-direction: column; gap: 4px;">
      <input type="number" id="withdraw-amount" placeholder="USDC amount" step="0.01" min="0.01" style="background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; color: var(--text); font-family: inherit; font-size: 12px; width: 100px;">
      <button class="act-btn act-btn-approve" onclick="withdrawFees()">Withdraw</button>
    </div>
  </div>
  <div id="withdraw-status" style="color: var(--muted); font-size: 11px; margin-top: 4px;"></div>
</div>

<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Product</th>
      <th>Set</th>
      <th>Backend $</th>
      <th>Backend Age</th>
      <th>ER $</th>
      <th>ER Age</th>
      <th>Diff</th>
      <th>Status</th>
      <th>Tradable</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>

<script>
const REFRESH_MS = 2000;
let tick = 0;

function fmt$(v) { return v != null ? '$' + Number(v).toFixed(2) : '—'; }
function fmtAge(s) {
  if (s == null) return '—';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

function renderStats(d) {
  const pendingAct = d.activation_requests ? d.activation_requests.pending_count : 0;
  const items = [
    { label: 'Products', value: d.total, cls: '' },
    { label: 'Tradable', value: d.total - d.totals.inactive, cls: d.totals.inactive === 0 ? 'fresh' : '' },
    { label: 'Inactive', value: d.totals.inactive, cls: d.totals.inactive > 0 ? 'missing' : 'fresh' },
    { label: 'Fresh', value: d.totals.fresh, cls: 'fresh' },
    { label: 'Stale', value: d.totals.stale, cls: 'stale' },
    { label: 'Missing', value: d.totals.missing, cls: 'missing' },
    { label: 'Activation Reqs', value: pendingAct, cls: pendingAct > 0 ? 'stale' : '' },
    { label: 'WS Clients', value: d.ws_clients, cls: d.ws_clients > 0 ? 'fresh' : '' },
    { label: 'Analyzed', value: d.data.total_analyzed, cls: '' },
    { label: 'Proxy', value: d.proxy_enabled ? 'ON' : 'OFF', cls: d.proxy_enabled ? 'fresh' : '' },
    { label: 'Health', value: d.total > 0 ? Math.round(d.totals.fresh / d.total * 100) + '%' : '—', cls: d.totals.fresh === d.total ? 'fresh' : d.totals.fresh > 0 ? 'stale' : 'missing' },
  ];
  document.getElementById('stats').innerHTML = items.map(i =>
    '<div class="stat"><div class="stat-label">' + i.label + '</div><div class="stat-value ' + i.cls + '">' + i.value + '</div></div>'
  ).join('');
}

function renderLoops(loops) {
  document.getElementById('loops').innerHTML = loops.map(l => {
    const dur = l.lastDurationMs != null ? (l.lastDurationMs < 1000 ? l.lastDurationMs + 'ms' : (l.lastDurationMs / 1000).toFixed(1) + 's') : '—';
    const ago = l.lastRunAt ? fmtAge(Math.round((Date.now() - l.lastRunAt) / 1000)) + ' ago' : 'never';
    const prog = l.state === 'running' && l.progress != null ? ' (' + Math.round(l.progress * 100) + '%)' : '';
    return '<div class="loop-card">' +
      '<div class="loop-name">' + l.name + ' <span class="loop-state ' + l.state + '">' + l.state + prog + '</span></div>' +
      '<div class="loop-meta">Runs: ' + l.runCount + ' | Last: ' + ago + ' | Duration: ' + dur +
      (l.lastOk || l.lastFail ? ' | OK: ' + l.lastOk + ' Fail: ' + l.lastFail : '') +
      '</div></div>';
  }).join('');
}

function renderRows(rows) {
  document.getElementById('tbody').innerHTML = rows.map((r, i) => {
    const img = r.image_url ? '<img class="img-thumb" src="' + r.image_url + '" loading="lazy" onerror="this.style.display=\\'none\\'">' : '';
    const name = r.tcgplayer_url ? '<a href="' + r.tcgplayer_url + '" target="_blank">' + esc(r.product_name) + '</a>' : esc(r.product_name);
    // Row color: green if ER price > backend (ER is higher), red if ER < backend, neutral if same or no data
    let rowCls = '';
    if (!r.tradable) {
      rowCls = 'inactive-row';
    } else if (r.er_diff_pct != null && Math.abs(r.er_diff_pct) > 0.005) {
      rowCls = r.er_diff_pct > 0 ? 'er-up' : 'er-down';
    }
    // Diff cell
    let diffCell = '—';
    if (r.er_diff_pct != null) {
      if (Math.abs(r.er_diff_pct) <= 0.005) {
        diffCell = '<span class="change-zero">0.00%</span>';
      } else {
        const cls = r.er_diff_pct > 0 ? 'change-pos' : 'change-neg';
        const sign = r.er_diff_pct > 0 ? '+' : '';
        diffCell = '<span class="' + cls + '">' + sign + r.er_diff_pct.toFixed(2) + '%</span>';
      }
    }
    // Tradable cell
    const tradableCell = r.tradable
      ? '<span class="badge badge-active">active</span>'
      : '<span class="badge badge-inactive">inactive</span>' + (r.inactive_reason ? '<div class="reason">' + esc(r.inactive_reason) + '</div>' : '');
    return '<tr class="' + rowCls + '">' +
      '<td>' + (i + 1) + '</td>' +
      '<td><div class="product-cell">' + img + '<div><div class="product-name">' + name + '</div></div></div></td>' +
      '<td class="set-name">' + esc(r.set_name || '') + '</td>' +
      '<td class="price">' + fmt$(r.live_price) + '</td>' +
      '<td>' + fmtAge(r.age_seconds) + '</td>' +
      '<td class="price">' + fmt$(r.er_price) + '</td>' +
      '<td>' + fmtAge(r.er_age_seconds) + '</td>' +
      '<td>' + diffCell + '</td>' +
      '<td><span class="badge badge-' + r.status + '">' + r.status + '</span></td>' +
      '<td>' + tradableCell + '</td>' +
      '</tr>';
  }).join('');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function renderActivationRequests(d) {
  const ar = d.activation_requests;
  if (!ar) return;
  document.getElementById('activation-count').textContent = ar.pending_count;
  const list = document.getElementById('activation-list');
  if (!ar.requests || ar.requests.length === 0) {
    list.innerHTML = '<div class="act-empty">No pending activation requests</div>';
    return;
  }
  list.innerHTML = ar.requests.map(r => {
    const ago = fmtAge(Math.round((Date.now() - r.last_requested_at) / 1000));
    const walletList = (r.wallets || []).map(w => w.slice(0, 4) + '..' + w.slice(-4)).join(', ');
    return '<div class="act-card" id="act-' + r.product_id + '">' +
      '<div class="act-info">' +
        '<div class="act-product">#' + r.product_id + ' — ' + esc(r.product_name || 'Unknown') + '</div>' +
        '<div class="act-meta">' + r.request_count + ' request' + (r.request_count > 1 ? 's' : '') + ' · last ' + ago + ' ago</div>' +
        '<div class="act-wallets">' + esc(walletList) + '</div>' +
      '</div>' +
      '<div class="act-actions">' +
        '<button class="act-btn act-btn-approve" onclick="actAction(' + r.product_id + ',\\'approve\\')">Approve</button>' +
        '<button class="act-btn act-btn-reject" onclick="actAction(' + r.product_id + ',\\'reject\\')">Reject</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function actAction(productId, action) {
  const key = document.getElementById('admin-key').value;
  if (!key) { alert('Enter admin password first'); return; }
  const card = document.getElementById('act-' + productId);
  if (card) card.style.opacity = '0.4';
  try {
    const res = await fetch('/api/trading/admin/activation-requests/' + productId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ action: action }),
    });
    const data = await res.json();
    if (data.error) { alert('Error: ' + data.error); if (card) card.style.opacity = '1'; return; }
    if (card) card.remove();
    // Update count
    const countEl = document.getElementById('activation-count');
    const cur = parseInt(countEl.textContent) || 0;
    if (cur > 0) countEl.textContent = cur - 1;
  } catch (e) {
    alert('Failed: ' + e.message);
    if (card) card.style.opacity = '1';
  }
}

function renderExchange(d) {
  const ex = d.exchange;
  if (!ex) return;
  // Values are already in USD (perpdex service divides by 1e6)
  const depositsUsd = ex.totalDeposits || 0;
  const feesUsd = ex.totalFeesCollected || 0;
  document.getElementById('total-deposits').textContent = '$' + depositsUsd.toFixed(2);
  document.getElementById('fees-collected').textContent = '$' + feesUsd.toFixed(2);
  document.getElementById('treasury-wallet').textContent = ex.treasuryWallet || '—';
}

async function withdrawFees() {
  const key = document.getElementById('admin-key').value;
  if (!key) { alert('Enter admin password first'); return; }
  const amountInput = document.getElementById('withdraw-amount');
  const amountUsdc = parseFloat(amountInput.value);
  if (!amountUsdc || amountUsdc <= 0) { alert('Enter a valid amount'); return; }
  // Convert to native units (6 decimals)
  const amountNative = Math.floor(amountUsdc * 1e6);
  const statusEl = document.getElementById('withdraw-status');
  statusEl.textContent = 'Withdrawing...';
  statusEl.style.color = 'var(--muted)';
  try {
    const res = await fetch('/api/trading/admin/withdraw-fees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ amount: amountNative }),
    });
    const data = await res.json();
    if (data.error) {
      statusEl.textContent = 'Error: ' + data.error;
      statusEl.style.color = 'var(--red)';
      return;
    }
    statusEl.textContent = 'Withdrawn $' + amountUsdc.toFixed(2) + ' — TX: ' + (data.signature || '').slice(0, 16) + '...';
    statusEl.style.color = 'var(--green)';
    amountInput.value = '';
    // Refresh data to update balances
    setTimeout(refresh, 2000);
  } catch (e) {
    statusEl.textContent = 'Failed: ' + e.message;
    statusEl.style.color = 'var(--red)';
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/dashboard/monitor/data');
    const d = await res.json();
    renderStats(d);
    renderLoops(d.loops);
    renderActivationRequests(d);
    renderExchange(d);
    renderRows(d.rows);
    document.getElementById('subtitle').textContent =
      'Monitoring top ' + d.total + ' products | Updated ' + new Date(d.timestamp).toLocaleTimeString() +
      ' | Archive: ' + (d.data.oldest_date || '?') + ' to ' + (d.data.newest_date || '?');
  } catch (e) {
    document.getElementById('subtitle').textContent = 'Error: ' + e.message;
  }
  tick++;
  document.getElementById('refresh').textContent = 'Next refresh in ' + Math.ceil((REFRESH_MS - (tick % (REFRESH_MS/1000)) * 1000) / 1000) + 's';
}

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(() => {
  document.getElementById('refresh').textContent = 'Refreshing in ' + Math.ceil(REFRESH_MS / 1000) + 's';
}, 1000);
</script>
</body>
</html>`;
