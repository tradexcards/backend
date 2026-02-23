/**
 * Oracle routes — /api/oracle
 *
 * Provides pricing data for the oracle feed. Currently backend-only
 * (no on-chain reads). The /router/prices endpoint is the primary
 * one the frontend polls — it returns cached pricing for all top
 * tradable products.
 */

import { Elysia } from "elysia";
import { env, readActiveProductIds } from "../env";
import { tcgplayer } from "../services/tcgplayer";
import { keeper } from "../services/oracle/keeper";
import { timingSafeEqual } from "../utils/crypto";
import type { ProductPricing } from "../models";

// ── Helpers ─────────────────────────────────────────────────────────────────

const PRICE_DECIMALS = 8;
const PRICE_SCALE = Math.pow(10, PRICE_DECIMALS);

function scalePrice(price: number): number | null {
    if (!Number.isFinite(price) || price <= 0) return null;
    const scaled = Math.round(price * PRICE_SCALE);
    if (!Number.isSafeInteger(scaled)) return null;
    return scaled;
}

function pickPrice(pricing: ProductPricing): number | null {
    const price = pricing.market_price || pricing.lowest_price || 0;
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
}

function getPricingAgeSeconds(pricing: ProductPricing): number | null {
    if (!pricing?.fetched_at) return null;
    const timestamp = new Date(pricing.fetched_at).getTime();
    if (!Number.isFinite(timestamp)) return null;
    return (Date.now() - timestamp) / 1000;
}

function isPricingFresh(
    pricing: ProductPricing,
    maxAgeSeconds: number,
): { fresh: boolean; ageSeconds: number | null } {
    const ageSeconds = getPricingAgeSeconds(pricing);
    return {
        fresh: ageSeconds !== null && ageSeconds <= maxAgeSeconds,
        ageSeconds,
    };
}

/** Read active product IDs (respects active.txt override). */
function readTradableIds(): number[] {
    return readActiveProductIds(env().prefetch.topCount);
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const oracleRoutes = new Elysia({ prefix: "/api/oracle" })

    .get("/status", () => {
        const cfg = env();
        const tradableIds = readTradableIds();
        const k = keeper();

        return {
            initialized: true,
            oracle_pubkey: null,
            network: cfg.program.network,
            program_id: cfg.program.programId,
            tradable_products: tradableIds.length,
            max_price_age_seconds: cfg.program.maxPriceAgeSeconds,
            keeper: k ? (() => {
                const stats = k.getStats();
                // Strip RPC URLs that may contain API keys from public endpoint
                const { baseEndpoint, ...safeStats } = stats;
                return {
                    running: k.isRunning(),
                    ...safeStats,
                    baseEndpoint: baseEndpoint ? baseEndpoint.replace(/[?&]api[-_]?key=[^&]*/gi, "?api-key=***") : null,
                };
            })() : null,
        };
    }, {
        detail: {
            tags: ["Oracle"],
            summary: "Oracle status",
            description: "Basic oracle status including network, program ID, and keeper stats",
        },
    })

    .get("/prices", async () => {
        const cfg = env();
        const client = tcgplayer();
        const tradableIds = readTradableIds();
        const maxPriceAge = cfg.program.maxPriceAgeSeconds;

        if (tradableIds.length === 0) {
            return {
                error: "No tradable product IDs configured",
                hint: "Run initial sync first to populate top.txt",
            };
        }

        const prices: Array<{
            product_id: number;
            price_usd: number;
            price_scaled: number;
            age_seconds: number;
        }> = [];
        let staleSkipped = 0;

        for (const productId of tradableIds) {
            const pricing = await client.getCachedPricingRaw(productId);
            if (!pricing) { staleSkipped++; continue; }

            const { fresh, ageSeconds } = isPricingFresh(pricing, maxPriceAge);
            if (!fresh) { staleSkipped++; continue; }

            const price = pickPrice(pricing);
            if (price === null) continue;

            const scaled = scalePrice(price);
            if (scaled === null) continue;

            prices.push({
                product_id: productId,
                price_usd: price,
                price_scaled: scaled,
                age_seconds: Math.round(ageSeconds ?? 0),
            });
        }

        return {
            timestamp: Date.now(),
            network: cfg.program.network,
            total: prices.length,
            max_price_age_seconds: maxPriceAge,
            stale_skipped: staleSkipped,
            prices,
        };
    }, {
        detail: {
            tags: ["Oracle"],
            summary: "Get all prices",
            description: "All tradable card prices from backend cache (unsigned, for display)",
        },
    })

    .get("/router/prices", async () => {
        const cfg = env();
        const client = tcgplayer();
        const tradableIds = readTradableIds();
        const maxPriceAge = cfg.program.maxPriceAgeSeconds;

        if (tradableIds.length === 0) {
            return {
                timestamp: Date.now(),
                network: cfg.program.network,
                total: 0,
                max_price_age_seconds: maxPriceAge,
                stale_count: 0,
                prices: [],
            };
        }

        // Fetch all cached pricing in parallel
        const pricingResults = await Promise.all(
            tradableIds.map(async (productId) => {
                const pricing = await client.getCachedPricingRaw(productId);
                return { productId, pricing };
            }),
        );

        const prices: Array<{
            product_id: number;
            price_usd: number | null;
            price_scaled: number | null;
            age_seconds: number | null;
            source: "onchain" | "backend" | "stale";
        }> = [];
        let staleCount = 0;

        for (const { productId, pricing } of pricingResults) {
            if (pricing) {
                const { fresh, ageSeconds } = isPricingFresh(pricing, maxPriceAge);
                const price = pickPrice(pricing);
                const scaled = price !== null ? scalePrice(price) : null;

                if (fresh && price !== null && scaled !== null) {
                    prices.push({
                        product_id: productId,
                        price_usd: price,
                        price_scaled: scaled,
                        age_seconds: Math.max(0, Math.round(ageSeconds ?? 0)),
                        source: "backend",
                    });
                    continue;
                }
            }

            // No fresh pricing available
            prices.push({
                product_id: productId,
                price_usd: null,
                price_scaled: null,
                age_seconds: null,
                source: "stale",
            });
            staleCount++;
        }

        return {
            timestamp: Date.now(),
            network: cfg.program.network,
            total: prices.length,
            max_price_age_seconds: maxPriceAge,
            stale_count: staleCount,
            prices,
        };
    }, {
        detail: {
            tags: ["Oracle"],
            summary: "Router prices",
            description: "Primary price endpoint for frontend polling. Returns prices for all tradable products.",
        },
    });
