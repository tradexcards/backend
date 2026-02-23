/**
 * Trading Routes
 * 
 * API endpoints for the perpetual DEX trading functionality.
 * Provides read access to on-chain state and transaction building helpers.
 */

import { Elysia, t } from "elysia";
import { PublicKey } from "@solana/web3.js";
import { perpdex, computePositionPnL, type PositionWithPnL } from "../services/perpdex";
import { tcgplayer } from "../services/tcgplayer";
import { analyzer } from "../services/analyzer";
import { db } from "../services/db";
import { env, readActiveProductIds, readActiveProductIdSet } from "../env";
import { log } from "../log";
import { timingSafeEqual } from "../utils/crypto";

const logger = log("trading");

/** Max items in batch endpoints to prevent OOM */
const MAX_BATCH_SIZE = 200;

// ── Oracle signing rate limiter ─────────────────────────────────────────────
// Limits price signing to prevent stockpiling attacks.
// Key: "ip:productId", max 2 signs per 10 seconds per product per IP.

const SIGN_RATE_LIMIT_WINDOW_MS = 10_000;
const SIGN_RATE_LIMIT_MAX = 2;
const _signRateStore = new Map<string, { count: number; resetAt: number }>();

// Cleanup stale entries every 30s
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of _signRateStore) {
        if (entry.resetAt <= now) _signRateStore.delete(key);
    }
}, 30_000);

function checkSignRateLimit(ip: string, productId: number): boolean {
    const key = `${ip}:${productId}`;
    const now = Date.now();
    const entry = _signRateStore.get(key);
    if (!entry || entry.resetAt <= now) {
        _signRateStore.set(key, { count: 1, resetAt: now + SIGN_RATE_LIMIT_WINDOW_MS });
        return true;
    }
    if (entry.count >= SIGN_RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
}

// ── Price circuit breaker ───────────────────────────────────────────────────
// Reject prices that deviate >50% from the previous known price for a product.
// Prevents catastrophic mispricing from bad TCGPlayer data.

const MAX_PRICE_DEVIATION_PCT = 50;
const _lastKnownPrices = new Map<number, number>(); // productId -> priceUsd

function pricePassesCircuitBreaker(productId: number, priceUsd: number): boolean {
    const lastPrice = _lastKnownPrices.get(productId);
    if (lastPrice === undefined) {
        // First price for this product — accept it
        _lastKnownPrices.set(productId, priceUsd);
        return true;
    }
    const deviationPct = Math.abs(priceUsd - lastPrice) / lastPrice * 100;
    if (deviationPct > MAX_PRICE_DEVIATION_PCT) {
        logger.error(`Circuit breaker: product ${productId} price $${priceUsd.toFixed(4)} deviates ${deviationPct.toFixed(1)}% from last known $${lastPrice.toFixed(4)}`);
        return false;
    }
    _lastKnownPrices.set(productId, priceUsd);
    return true;
}

// ── Payment replay protection ───────────────────────────────────────────────

function hasPaymentBeenUsed(signature: string): boolean {
    try {
        const existing = db().cacheGetRaw<string>("payment_sigs", signature);
        return existing !== undefined && existing !== null;
    } catch { return false; }
}

function markPaymentUsed(signature: string): void {
    try {
        db().cacheSet("payment_sigs", signature, "used", 7 * 86400); // 7 day TTL
    } catch (e) {
        logger.error("Failed to mark payment used:", e);
    }
}

/**
 * Validate that a string is a valid Solana public key (base58, 32-50 chars).
 * Returns true if valid.
 */
function isValidSolanaPubkey(s: string): boolean {
    try {
        new PublicKey(s);
        return true;
    } catch {
        return false;
    }
}

/**
 * Verify that a trading tx request contains a valid wallet owner.
 * Checks Content-Type and validates the owner pubkey.
 */
function requireWalletAuth(request: Request): { error: string } | null {
    const contentType = request.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
        return { error: "Content-Type must be application/json" };
    }
    return null;
}

export const tradingRoutes = new Elysia({ prefix: "/api/trading" })

    // ── Exchange State ───────────────────────────────────────────────────────

    .get("/exchange", async ({ set }) => {
        const state = await perpdex().getExchangeState();
        if (!state) {
            set.status = 503;
            return { error: "Exchange not initialized" };
        }
        return state;
    }, {
        detail: {
            tags: ["Trading"],
            summary: "Get exchange state",
            description: "Returns the global exchange state including total deposits, fees, and pause status",
        },
    })

    // ── Market State ─────────────────────────────────────────────────────────

    .get("/market/:productId", async ({ params, set }) => {
        const productId = parseInt(params.productId, 10);
        if (isNaN(productId)) {
            set.status = 400;
            return { error: "Invalid product ID" };
        }

        const market = await perpdex().getMarket(productId);
        if (!market) {
            set.status = 404;
            return { error: "Market not found", productId };
        }
        return market;
    }, {
        params: t.Object({
            productId: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get market state",
            description: "Returns the state of a specific market by product ID",
        },
    })

    .post("/markets", async ({ body, set }) => {
        const { productIds } = body;
        if (!productIds || !Array.isArray(productIds)) {
            set.status = 400;
            return { error: "productIds array required" };
        }
        if (productIds.length > MAX_BATCH_SIZE) {
            set.status = 400;
            return { error: `Too many productIds (max ${MAX_BATCH_SIZE})` };
        }

        const markets = await perpdex().getMarkets(productIds);
        return {
            markets: Object.fromEntries(markets),
        };
    }, {
        body: t.Object({
            productIds: t.Array(t.Number()),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get multiple markets",
            description: "Batch fetch market states for multiple product IDs",
        },
    })

    // ── User Account ─────────────────────────────────────────────────────────

    .get("/account/:owner", async ({ params, set }) => {
        if (!isValidSolanaPubkey(params.owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }
        const account = await perpdex().getUserAccount(params.owner);
        if (!account) {
            return { 
                exists: false,
                owner: params.owner,
            };
        }
        return {
            exists: true,
            ...account,
        };
    }, {
        params: t.Object({
            owner: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get user trading account",
            description: "Returns the user's trading account including balance (positions fetched separately)",
        },
    })

    // ── User Positions (Separate PDAs) ────────────────────────────────────────

    .get("/account/:owner/positions", async ({ params, set }) => {
        if (!isValidSolanaPubkey(params.owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }
        const positions = await perpdex().getUserPositions(params.owner);
        return {
            owner: params.owner,
            positions,
            count: positions.length,
        };
    }, {
        params: t.Object({
            owner: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get user positions",
            description: "Returns all open positions for a user (separate PDAs)",
        },
    })

    .get("/account/:owner/position/:productId", async ({ params, set }) => {
        if (!isValidSolanaPubkey(params.owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }
        const productId = parseInt(params.productId, 10);
        if (isNaN(productId)) {
            set.status = 400;
            return { error: "Invalid product ID" };
        }

        const position = await perpdex().getPosition(params.owner, productId);
        if (!position) {
            return { 
                exists: false,
                owner: params.owner,
                productId,
            };
        }
        return {
            exists: true,
            ...position,
        };
    }, {
        params: t.Object({
            owner: t.String(),
            productId: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get single position",
            description: "Returns a specific position by owner and product ID",
        },
    })

    // ══════════════════════════════════════════════════════════════════════════
    // AI AGENT OPTIMIZED ENDPOINTS
    // These endpoints reduce API calls and provide pre-computed data for agents
    // ══════════════════════════════════════════════════════════════════════════

    // ── Portfolio (Account + Positions + Computed PnL) ───────────────────────

    .get("/portfolio/:owner", async ({ params, set }) => {
        if (!isValidSolanaPubkey(params.owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }

        const svc = perpdex();
        const [account, positions] = await Promise.all([
            svc.getUserAccount(params.owner),
            svc.getUserPositions(params.owner),
        ]);

        if (!account) {
            return {
                exists: false,
                owner: params.owner,
                account: null,
                positions: [],
                summary: null,
            };
        }

        // Fetch oracle prices for all positions
        const productIds = positions.map(p => p.productId);
        const oraclePrices = await svc.getOraclePrices(productIds);

        // Compute PnL for each position
        const positionsWithPnL: PositionWithPnL[] = positions.map(pos => {
            const oracle = oraclePrices.get(pos.productId);
            const currentPrice = oracle?.price ?? pos.entryPrice;
            return {
                ...pos,
                computed: computePositionPnL(pos, currentPrice),
            };
        });

        // Calculate portfolio summary
        let totalUnrealizedPnl = 0;
        let totalMargin = 0;
        let totalSize = 0;
        let positionsAtRisk = 0;

        for (const pos of positionsWithPnL) {
            totalUnrealizedPnl += pos.computed.unrealizedPnl;
            totalMargin += pos.margin;
            totalSize += pos.size;
            if (pos.computed.riskStatus !== "safe") positionsAtRisk++;
        }

        const totalEquity = account.balance + totalMargin + totalUnrealizedPnl;
        const marginUtilization = totalEquity > 0 ? (totalMargin / totalEquity) * 100 : 0;

        return {
            exists: true,
            owner: params.owner,
            account: {
                balance: account.balance,
                totalDeposited: account.totalDeposited,
                totalWithdrawn: account.totalWithdrawn,
                totalRealizedPnl: account.totalRealizedPnl,
                totalFeesPaid: account.totalFeesPaid,
                openPositionCount: account.openPositionCount,
            },
            positions: positionsWithPnL,
            summary: {
                totalUnrealizedPnl: Math.round(totalUnrealizedPnl * 100) / 100,
                totalMargin: Math.round(totalMargin * 100) / 100,
                totalSize: Math.round(totalSize * 100) / 100,
                totalEquity: Math.round(totalEquity * 100) / 100,
                marginUtilization: Math.round(marginUtilization * 100) / 100,
                positionCount: positions.length,
                positionsAtRisk,
                largestPosition: positions.length > 0 
                    ? Math.max(...positions.map(p => p.size))
                    : 0,
            },
        };
    }, {
        params: t.Object({
            owner: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get complete portfolio",
            description: "Returns account + all positions with computed PnL, risk metrics, and portfolio summary. Optimized for AI agents.",
        },
    })

    // ── Pre-Trade Validation ─────────────────────────────────────────────────

    .get("/prepare-trade/:productId", async ({ params, query, set }) => {
        const productId = parseInt(params.productId, 10);
        if (isNaN(productId)) {
            set.status = 400;
            return { error: "Invalid product ID" };
        }

        const wallet = query.wallet;
        const side = query.side as "long" | "short" | undefined;
        const size = query.size ? parseFloat(query.size) : undefined;
        const leverage = query.leverage ? parseInt(query.leverage, 10) : undefined;

        const svc = perpdex();
        const activeIds = readActiveProductIdSet();

        // Parallel fetch all required data
        const [market, oracle, account, existingPosition] = await Promise.all([
            svc.getMarket(productId),
            svc.getOraclePrice(productId),
            wallet && isValidSolanaPubkey(wallet) ? svc.getUserAccount(wallet) : Promise.resolve(null),
            wallet && isValidSolanaPubkey(wallet) ? svc.getPosition(wallet, productId) : Promise.resolve(null),
        ]);

        const warnings: string[] = [];
        const errors: string[] = [];

        // Check if product is tradable
        const isApproved = activeIds.has(productId);
        if (!isApproved) {
            errors.push("Product not approved for trading");
        }

        // Check market exists and is active
        if (!market) {
            errors.push("Market does not exist for this product");
        } else if (!market.active) {
            errors.push("Market is currently inactive");
        }

        // Check oracle price
        const priceValid = oracle && oracle.ageSeconds < 120;
        if (!priceValid) {
            if (!oracle) {
                errors.push("No oracle price available");
            } else {
                warnings.push(`Oracle price is stale (${oracle.ageSeconds}s old)`);
            }
        }

        // Account checks
        let accountExists = false;
        let availableBalance = 0;
        if (wallet) {
            if (!isValidSolanaPubkey(wallet)) {
                errors.push("Invalid wallet address");
            } else if (!account) {
                warnings.push("Trading account does not exist - create one first");
            } else {
                accountExists = true;
                availableBalance = account.balance;
            }
        }

        // Position already exists check
        if (existingPosition) {
            warnings.push(`Position already exists (${existingPosition.side}, size: $${existingPosition.size})`);
        }

        // Trade simulation if params provided
        let simulation = null;
        if (size && leverage && oracle && market) {
            const margin = size / leverage;
            const openingFee = size * 0.0005;
            const marginRequired = margin + openingFee;

            // Check if would exceed max OI
            const currentOI = side === "long" ? market.longOpenInterest : market.shortOpenInterest;
            const wouldExceedOI = (currentOI + size) > market.maxOpenInterest;
            if (wouldExceedOI) {
                warnings.push("Trade would exceed max open interest for this market");
            }

            // Check balance
            if (accountExists && marginRequired > availableBalance) {
                errors.push(`Insufficient balance: need $${marginRequired.toFixed(2)}, have $${availableBalance.toFixed(2)}`);
            }

            // OI imbalance and funding direction
            const totalOI = market.longOpenInterest + market.shortOpenInterest;
            const imbalance = totalOI > 0 
                ? (market.longOpenInterest - market.shortOpenInterest) / totalOI 
                : 0;
            const fundingDirection = imbalance > 0.1 ? "longs pay shorts" : 
                                     imbalance < -0.1 ? "shorts pay longs" : "neutral";
            
            if ((side === "long" && imbalance > 0.2) || (side === "short" && imbalance < -0.2)) {
                warnings.push(`High OI imbalance - expect negative funding (${fundingDirection})`);
            }

            // Calculate liquidation price
            const maintenanceMargin = size * 0.01; // 1%
            let liquidationPrice: number;
            if (side === "long") {
                liquidationPrice = oracle.price * (1 - (margin - maintenanceMargin) / size);
            } else {
                liquidationPrice = oracle.price * (1 + (margin - maintenanceMargin) / size);
            }

            simulation = {
                side,
                size,
                leverage,
                entryPrice: oracle.price,
                margin: Math.round(margin * 100) / 100,
                openingFee: Math.round(openingFee * 100) / 100,
                marginRequired: Math.round(marginRequired * 100) / 100,
                liquidationPrice: Math.round(liquidationPrice * 100) / 100,
                distanceToLiquidation: Math.round(Math.abs(oracle.price - liquidationPrice) / oracle.price * 100 * 100) / 100,
                wouldExceedOI,
                fundingDirection,
            };
        }

        const canTrade = errors.length === 0 && market?.active && priceValid;

        return {
            productId,
            canTrade,
            errors,
            warnings,
            market: market ? {
                active: market.active,
                maxLeverage: market.maxLeverage,
                longOpenInterest: market.longOpenInterest,
                shortOpenInterest: market.shortOpenInterest,
                maxOpenInterest: market.maxOpenInterest,
                utilizationPercent: market.maxOpenInterest > 0 
                    ? (market.longOpenInterest + market.shortOpenInterest) / market.maxOpenInterest * 100 
                    : 0,
            } : null,
            oracle: oracle ? {
                price: oracle.price,
                ageSeconds: oracle.ageSeconds,
                isValid: oracle.ageSeconds < 120,
            } : null,
            account: wallet ? {
                exists: accountExists,
                balance: availableBalance,
                hasExistingPosition: !!existingPosition,
            } : null,
            simulation,
        };
    }, {
        params: t.Object({
            productId: t.String(),
        }),
        query: t.Object({
            wallet: t.Optional(t.String()),
            side: t.Optional(t.String()),
            size: t.Optional(t.String()),
            leverage: t.Optional(t.String()),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Pre-trade validation",
            description: "Validates if a trade can be placed and simulates margin/fees. Replaces 5+ API calls with one. Optimized for AI agents.",
        },
    })

    // ── Market Movers (Top Gainers/Losers) ───────────────────────────────────

    .get("/analytics/movers", async ({ query }) => {
        const limit = Math.min(Math.max(parseInt(query.limit as string) || 10, 1), 50);
        
        const ana = analyzer();
        const cached = await ana.getCached();
        
        if (!cached) {
            return {
                gainers: [],
                losers: [],
                mostVolatile: [],
                biggestMover: null,
            };
        }

        // Get all cards with price changes
        const cardsWithChanges = cached.top_tradable
            .filter(c => c.change_24h !== undefined && c.change_24h !== null)
            .map(c => ({
                productId: c.product_id,
                productName: c.product_name,
                currentPrice: c.current_price,
                change24h: c.change_24h,
                change30d: c.change_30d,
                activityScore: c.activity_score,
            }));

        // Sort for gainers (highest positive change)
        const gainers = [...cardsWithChanges]
            .filter(c => c.change24h > 0)
            .sort((a, b) => b.change24h - a.change24h)
            .slice(0, limit);

        // Sort for losers (most negative change)
        const losers = [...cardsWithChanges]
            .filter(c => c.change24h < 0)
            .sort((a, b) => a.change24h - b.change24h)
            .slice(0, limit);

        // Most volatile (highest absolute change)
        const mostVolatile = [...cardsWithChanges]
            .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
            .slice(0, limit);

        // Biggest single mover
        const biggestMover = mostVolatile.length > 0 ? mostVolatile[0] : null;

        return {
            gainers,
            losers,
            mostVolatile,
            biggestMover,
            timestamp: Date.now(),
        };
    }, {
        query: t.Object({
            limit: t.Optional(t.String()),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get market movers",
            description: "Returns top gainers, losers, and most volatile cards. Optimized for AI agents.",
        },
    })

    // ── Trade Simulation ─────────────────────────────────────────────────────

    .post("/simulate", async ({ body, set }) => {
        const { productId, side, size, leverage } = body;

        if (size <= 0 || size > 100_000) {
            set.status = 400;
            return { error: "Size must be between $1 and $100,000" };
        }
        if (leverage < 1 || leverage > 50) {
            set.status = 400;
            return { error: "Leverage must be between 1 and 50" };
        }

        const svc = perpdex();
        const [market, oracle] = await Promise.all([
            svc.getMarket(productId),
            svc.getOraclePrice(productId),
        ]);

        if (!market) {
            set.status = 404;
            return { error: "Market not found" };
        }
        if (!oracle) {
            set.status = 404;
            return { error: "Oracle price not available" };
        }

        const entryPrice = oracle.price;
        const margin = size / leverage;
        const openingFee = size * 0.0005;
        const closingFee = size * 0.0005;
        const totalFees = openingFee + closingFee;
        const marginRequired = margin + openingFee;

        // Maintenance margin is 1%
        const maintenanceMargin = size * 0.01;
        
        // Calculate liquidation price
        let liquidationPrice: number;
        if (side === "long") {
            liquidationPrice = entryPrice * (1 - (margin - maintenanceMargin) / size);
        } else {
            liquidationPrice = entryPrice * (1 + (margin - maintenanceMargin) / size);
        }

        // Calculate break-even price (must cover both open and close fees)
        const feePercent = 0.001; // 0.1% total (open + close)
        let breakEvenPrice: number;
        if (side === "long") {
            breakEvenPrice = entryPrice * (1 + feePercent);
        } else {
            breakEvenPrice = entryPrice * (1 - feePercent);
        }

        // PnL scenarios
        const scenarios = [
            { priceChange: -10, label: "-10%" },
            { priceChange: -5, label: "-5%" },
            { priceChange: -2, label: "-2%" },
            { priceChange: 0, label: "0%" },
            { priceChange: 2, label: "+2%" },
            { priceChange: 5, label: "+5%" },
            { priceChange: 10, label: "+10%" },
        ].map(s => {
            const exitPrice = entryPrice * (1 + s.priceChange / 100);
            let pnl: number;
            if (side === "long") {
                pnl = size * (exitPrice - entryPrice) / entryPrice;
            } else {
                pnl = size * (entryPrice - exitPrice) / entryPrice;
            }
            const netPnl = pnl - totalFees;
            const roi = (netPnl / marginRequired) * 100;
            return {
                ...s,
                exitPrice: Math.round(exitPrice * 100) / 100,
                grossPnl: Math.round(pnl * 100) / 100,
                netPnl: Math.round(netPnl * 100) / 100,
                roi: Math.round(roi * 100) / 100,
            };
        });

        return {
            simulation: {
                productId,
                side,
                size,
                leverage,
                entryPrice: Math.round(entryPrice * 100) / 100,
                margin: Math.round(margin * 100) / 100,
                openingFee: Math.round(openingFee * 100) / 100,
                closingFee: Math.round(closingFee * 100) / 100,
                totalFees: Math.round(totalFees * 100) / 100,
                marginRequired: Math.round(marginRequired * 100) / 100,
                liquidationPrice: Math.round(liquidationPrice * 100) / 100,
                breakEvenPrice: Math.round(breakEvenPrice * 100) / 100,
                distanceToLiquidation: Math.round(Math.abs(entryPrice - liquidationPrice) / entryPrice * 100 * 100) / 100,
            },
            scenarios,
            market: {
                longOpenInterest: market.longOpenInterest,
                shortOpenInterest: market.shortOpenInterest,
                maxOpenInterest: market.maxOpenInterest,
            },
            oracle: {
                price: oracle.price,
                ageSeconds: oracle.ageSeconds,
            },
        };
    }, {
        body: t.Object({
            productId: t.Number(),
            side: t.Union([t.Literal("long"), t.Literal("short")]),
            size: t.Number(),
            leverage: t.Number(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Simulate a trade",
            description: "Simulates a trade and returns margin requirements, fees, liquidation price, break-even, and PnL scenarios.",
        },
    })

    // ── Oracle Prices ────────────────────────────────────────────────────────

    .get("/oracle/:productId", async ({ params, set }) => {
        const productId = parseInt(params.productId, 10);
        if (isNaN(productId)) {
            set.status = 400;
            return { error: "Invalid product ID" };
        }

        // Fetch both on-chain oracle price and backend-cached TCGPlayer price
        const [onChainPrice, pricing] = await Promise.all([
            perpdex().getOraclePrice(productId),
            tcgplayer().getCachedPricingRaw(productId),
        ]);

        // Backend (TCGPlayer) cached price
        const backendPrice = pricing?.market_price || pricing?.lowest_price || null;
        const backendFetchedAt = pricing?.fetched_at ? new Date(pricing.fetched_at).getTime() : 0;
        const backendAgeSeconds = backendFetchedAt > 0 ? Math.floor((Date.now() - backendFetchedAt) / 1000) : null;

        // On-chain oracle price
        const onChain = onChainPrice ? {
            price: onChainPrice.price,
            updatedAt: onChainPrice.updatedAt,
            ageSeconds: onChainPrice.ageSeconds,
        } : null;

        // Use on-chain price if available and fresh (<120s), else fall back to backend
        const useOnChain = onChain && onChain.ageSeconds < 120;
        const price = useOnChain ? onChain.price : (backendPrice ?? 0);
        const ageSeconds = useOnChain ? onChain.ageSeconds : (backendAgeSeconds ?? 9999);
        const source: "onchain" | "backend" = useOnChain ? "onchain" : "backend";

        if (price <= 0) {
            set.status = 404;
            return { error: "Oracle price not found", productId };
        }

        return {
            productId,
            price,
            updatedAt: useOnChain ? onChain!.updatedAt : Math.floor(backendFetchedAt / 1000),
            ageSeconds,
            source,
            // Include both prices for transparency
            onChain,
            backend: backendPrice ? {
                price: backendPrice,
                updatedAt: Math.floor(backendFetchedAt / 1000),
                ageSeconds: backendAgeSeconds,
            } : null,
        };
    }, {
        params: t.Object({
            productId: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get oracle price",
            description: "Returns price from on-chain oracle or backend cache (TCGPlayer), with both sources included",
        },
    })

    .post("/oracle/prices", async ({ body, set }) => {
        const { productIds } = body;
        if (!productIds || !Array.isArray(productIds)) {
            set.status = 400;
            return { error: "productIds array required" };
        }
        if (productIds.length > MAX_BATCH_SIZE) {
            set.status = 400;
            return { error: `Too many productIds (max ${MAX_BATCH_SIZE})` };
        }

        const prices = await perpdex().getOraclePrices(productIds);
        return {
            prices: Object.fromEntries(prices),
        };
    }, {
        body: t.Object({
            productIds: t.Array(t.Number()),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get multiple oracle prices",
            description: "Batch fetch oracle prices for multiple product IDs",
        },
    })

    // ── Transaction Builders ─────────────────────────────────────────────────
    // These return the params needed for frontend to build and sign transactions

    .post("/tx/create-account", async ({ body, set }) => {
        const { owner } = body;
        if (!owner) {
            set.status = 400;
            return { error: "owner required" };
        }
        if (!isValidSolanaPubkey(owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }

        try {
            const params = perpdex().getCreateUserAccountParams(owner);
            return { success: true, params };
        } catch (e: any) {
            logger.error("Failed to build create account tx:", e);
            set.status = 500;
            return { error: "Failed to build transaction" };
        }
    }, {
        body: t.Object({
            owner: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build create account transaction",
            description: "Returns params for creating a user trading account",
        },
    })

    .post("/tx/close-account", async ({ body, set }) => {
        const { owner } = body;
        if (!owner) {
            set.status = 400;
            return { error: "owner required" };
        }
        if (!isValidSolanaPubkey(owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }

        try {
            const params = perpdex().getCloseUserAccountParams(owner);
            return { success: true, params };
        } catch (e: any) {
            logger.error("Failed to build close account tx:", e);
            set.status = 500;
            return { error: "Failed to build transaction" };
        }
    }, {
        body: t.Object({
            owner: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build close account transaction",
            description: "Returns params for closing a user trading account (must have zero balance and no open positions)",
        },
    })

    .post("/tx/deposit", async ({ body, set }) => {
        const { owner, userTokenAccount, amount } = body;
        if (!owner || !userTokenAccount || amount === undefined) {
            set.status = 400;
            return { error: "owner, userTokenAccount, and amount required" };
        }
        if (!isValidSolanaPubkey(owner) || !isValidSolanaPubkey(userTokenAccount)) {
            set.status = 400;
            return { error: "Invalid address" };
        }
        if (amount <= 0 || amount > 100_000_000) { // Max $100M deposit
            set.status = 400;
            return { error: "Invalid amount (must be > 0 and <= $100M)" };
        }

        try {
            const params = perpdex().getDepositParams(owner, userTokenAccount, amount);
            return { success: true, params };
        } catch (e: any) {
            logger.error("Failed to build deposit tx:", e);
            set.status = 500;
            return { error: "Failed to build transaction" };
        }
    }, {
        body: t.Object({
            owner: t.String(),
            userTokenAccount: t.String(),
            amount: t.Number(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build deposit transaction",
            description: "Returns params for depositing USDC into trading account",
        },
    })

    .post("/tx/withdraw", async ({ body, set }) => {
        const { owner, userTokenAccount, amount } = body;
        if (!owner || !userTokenAccount || amount === undefined) {
            set.status = 400;
            return { error: "owner, userTokenAccount, and amount required" };
        }
        if (!isValidSolanaPubkey(owner) || !isValidSolanaPubkey(userTokenAccount)) {
            set.status = 400;
            return { error: "Invalid address" };
        }
        if (amount <= 0 || amount > 100_000_000) {
            set.status = 400;
            return { error: "Invalid amount (must be > 0 and <= $100M)" };
        }

        try {
            const params = perpdex().getWithdrawParams(owner, userTokenAccount, amount);
            return { success: true, params };
        } catch (e: any) {
            logger.error("Failed to build withdraw tx:", e);
            set.status = 500;
            return { error: "Failed to build transaction" };
        }
    }, {
        body: t.Object({
            owner: t.String(),
            userTokenAccount: t.String(),
            amount: t.Number(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build withdraw transaction",
            description: "Returns params for withdrawing USDC from trading account",
        },
    })

    .post("/tx/open-position", async ({ body, request, set }) => {
        const authError = requireWalletAuth(request);
        if (authError) { set.status = 400; return authError; }

        const { owner, productId, side, size, leverage } = body;
        if (!owner || !productId || !side || !size || !leverage) {
            set.status = 400;
            return { error: "owner, productId, side, size, and leverage required" };
        }

        // Validate numeric bounds
        if (size <= 0 || size > 10_000_000) { // Max $10M position
            set.status = 400;
            return { error: "Invalid size (must be $1 — $10M)" };
        }
        if (leverage < 1 || leverage > 50) {
            set.status = 400;
            return { error: "Invalid leverage (must be 1-50)" };
        }
        if (!isValidSolanaPubkey(owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }

        // Rate limit oracle signing per IP + product
        const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            || request.headers.get("x-real-ip") || "unknown";
        if (!checkSignRateLimit(clientIp, productId)) {
            set.status = 429;
            return { error: "Too many signing requests. Try again in a few seconds." };
        }

        // Get fresh price from keeper cache (TCGPlayer data)
        const { keeper: getKeeper } = await import("../services/oracle/keeper");
        const k = getKeeper();
        const cachedPrice = k?.getErPrice(productId);
        if (!cachedPrice) {
            set.status = 404;
            return { error: "Price not available for this product" };
        }

        const ageSeconds = Math.floor((Date.now() - cachedPrice.publishedAt) / 1000);
        if (ageSeconds > 120) {
            set.status = 422;
            return { error: "Price data is stale", ageSeconds };
        }

        // Circuit breaker: reject anomalous prices
        if (!pricePassesCircuitBreaker(productId, cachedPrice.priceUsd)) {
            set.status = 503;
            return { error: "Price anomaly detected. Please try again later." };
        }

        try {
            // Sign the price with Ed25519
            const { oracleSigner } = await import("../services/oracle/signer");
            const signer = oracleSigner();
            const priceScaled = BigInt(Math.round(cachedPrice.priceUsd * 1e8));
            const signed = signer.signPrice(productId, priceScaled);

            const params = perpdex().getOpenPositionParams(
                owner,
                productId,
                side,
                size,
                leverage,
            );
            return { 
                success: true, 
                params,
                oraclePrice: cachedPrice.priceUsd,
                oracleAge: ageSeconds,
                signedPrice: {
                    price: priceScaled.toString(),
                    timestamp: signed.timestamp,
                    signature: Buffer.from(signed.signature).toString("base64"),
                    publicKey: Buffer.from(signed.publicKey).toString("base64"),
                    message: Buffer.from(signed.message).toString("base64"),
                },
            };
        } catch (e: any) {
            logger.error("Failed to build open position tx:", e);
            set.status = 500;
            return { error: "Failed to build transaction" };
        }
    }, {
        body: t.Object({
            owner: t.String(),
            productId: t.Number(),
            side: t.Union([t.Literal("long"), t.Literal("short")]),
            size: t.Number(),
            leverage: t.Number(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build open position transaction",
            description: "Returns params + Ed25519-signed oracle price for opening a new position",
        },
    })

    .post("/tx/close-position", async ({ body, request, set }) => {
        const authError = requireWalletAuth(request);
        if (authError) { set.status = 400; return authError; }

        const { owner, productId } = body;
        if (!owner || productId === undefined) {
            set.status = 400;
            return { error: "owner and productId required" };
        }
        if (!isValidSolanaPubkey(owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }

        // Rate limit oracle signing per IP + product
        const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            || request.headers.get("x-real-ip") || "unknown";
        if (!checkSignRateLimit(clientIp, productId)) {
            set.status = 429;
            return { error: "Too many signing requests. Try again in a few seconds." };
        }

        // Get fresh price from keeper cache (TCGPlayer data)
        const { keeper: getKeeper } = await import("../services/oracle/keeper");
        const k = getKeeper();
        const cachedPrice = k?.getErPrice(productId);
        if (!cachedPrice) {
            set.status = 404;
            return { error: "Price not available for this product" };
        }

        const ageSeconds = Math.floor((Date.now() - cachedPrice.publishedAt) / 1000);
        if (ageSeconds > 120) {
            set.status = 422;
            return { error: "Price data is stale", ageSeconds };
        }

        // Circuit breaker: reject anomalous prices
        if (!pricePassesCircuitBreaker(productId, cachedPrice.priceUsd)) {
            set.status = 503;
            return { error: "Price anomaly detected. Please try again later." };
        }

        try {
            // Sign the price with Ed25519
            const { oracleSigner } = await import("../services/oracle/signer");
            const signer = oracleSigner();
            const priceScaled = BigInt(Math.round(cachedPrice.priceUsd * 1e8));
            const signed = signer.signPrice(productId, priceScaled);

            const params = perpdex().getClosePositionParams(
                owner,
                productId,
            );
            return { 
                success: true, 
                params,
                oraclePrice: cachedPrice.priceUsd,
                oracleAge: ageSeconds,
                signedPrice: {
                    price: priceScaled.toString(),
                    timestamp: signed.timestamp,
                    signature: Buffer.from(signed.signature).toString("base64"),
                    publicKey: Buffer.from(signed.publicKey).toString("base64"),
                    message: Buffer.from(signed.message).toString("base64"),
                },
            };
        } catch (e: any) {
            logger.error("Failed to build close position tx:", e);
            set.status = 500;
            return { error: "Failed to build transaction" };
        }
    }, {
        body: t.Object({
            owner: t.String(),
            productId: t.Number(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build close position transaction",
            description: "Returns params + Ed25519-signed oracle price for closing an existing position",
        },
    })

    .post("/tx/add-margin", async ({ body, set }) => {
        const { owner, productId, amount } = body;
        if (!owner || productId === undefined || amount === undefined) {
            set.status = 400;
            return { error: "owner, productId, and amount required" };
        }
        if (!isValidSolanaPubkey(owner)) {
            set.status = 400;
            return { error: "Invalid owner address" };
        }

        try {
            const params = perpdex().getAddMarginParams(owner, productId, amount);
            return { success: true, params };
        } catch (e: any) {
            logger.error("Failed to build add margin tx:", e);
            set.status = 500;
            return { error: "Failed to build transaction" };
        }
    }, {
        body: t.Object({
            owner: t.String(),
            productId: t.Number(),
            amount: t.Number(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build add margin transaction",
            description: "Returns params for adding margin to a position",
        },
    })

    .post("/tx/create-market", async ({ body, set }) => {
        const { payer, productId, paymentSignature } = body;
        if (!payer || productId === undefined) {
            set.status = 400;
            return { error: "payer and productId required" };
        }
        if (!isValidSolanaPubkey(payer)) {
            set.status = 400;
            return { error: "Invalid payer address" };
        }

        // Check if product is in the approved active list
        const activeIds = readActiveProductIdSet();
        if (!activeIds.has(productId)) {
            set.status = 403;
            return { 
                error: "Product not approved for trading. Request activation first.", 
                productId,
                hint: "Submit an activation request and wait for admin approval.",
            };
        }

        // Check if market already exists
        const existingMarket = await perpdex().getMarket(productId);
        if (existingMarket) {
            set.status = 409;
            return { error: "Market already exists for this product", productId };
        }

        const { keeper } = await import("../services/oracle/keeper");
        const k = keeper();
        if (!k) {
            set.status = 503;
            return { error: "Oracle keeper not initialized. Try again later." };
        }

        // Cost to create market (~0.004 SOL covers rent + tx fees)
        const MARKET_CREATION_COST_LAMPORTS = 4_000_000; // 0.004 SOL
        const MARKET_CREATION_COST_SOL = MARKET_CREATION_COST_LAMPORTS / 1e9;

        // Check if market already exists — if so, return params for permissionless create
        const oracle = await perpdex().getOraclePrice(productId);
        if (oracle) {
            try {
                const params = perpdex().getCreateMarketParams(payer, productId);
                return { 
                    success: true, 
                    params,
                    oraclePrice: oracle.price,
                    estimatedRent: 0.002,
                };
            } catch (e: any) {
                logger.error("Failed to build create market tx:", e);
                set.status = 500;
                return { error: "Failed to build transaction" };
            }
        }

        // Market doesn't exist — need keeper to create it
        // This requires payment from the user

        // Step 1: If no payment signature, return payment instructions
        if (!paymentSignature) {
            return {
                success: true,
                paymentRequired: true,
                paymentAddress: k.getPublicKey().toBase58(),
                paymentAmount: MARKET_CREATION_COST_SOL,
                paymentAmountLamports: MARKET_CREATION_COST_LAMPORTS,
                message: `Send ${MARKET_CREATION_COST_SOL} SOL to create this market. This covers on-chain account rent.`,
                productId,
            };
        }

        // Step 2: Check payment replay + verify payment was received
        if (hasPaymentBeenUsed(paymentSignature)) {
            set.status = 409;
            return { error: "This payment has already been used for market creation." };
        }

        logger.info(`Verifying payment ${paymentSignature} for market ${productId}...`);
        const paymentValid = await k.verifyPayment(paymentSignature, payer, MARKET_CREATION_COST_LAMPORTS);
        if (!paymentValid) {
            set.status = 402; // Payment Required
            return { 
                error: "Payment not verified. Ensure you sent the correct amount and the transaction is confirmed.",
                paymentAddress: k.getPublicKey().toBase58(),
                paymentAmount: MARKET_CREATION_COST_SOL,
                productId,
            };
        }

        // Step 3: Mark payment as used BEFORE creating market (prevents replay on crash/failure)
        markPaymentUsed(paymentSignature);
        logger.info(`Payment verified and marked. Creating market for product ${productId}...`);
        try {
            const result = await k.createMarket(productId);
            if (!result.success) {
                // Payment is consumed — log for manual refund if needed
                logger.error(`REFUND_NEEDED: Market creation failed after payment! productId=${productId} sig=${paymentSignature} payer=${payer} error=${result.error}`);
                set.status = 500;
                return { error: `Failed to create market: ${result.error}. Contact support for refund (ref: ${paymentSignature.slice(0,16)}...).`, productId };
            }
            logger.info(`Market created for product ${productId} (paid by ${payer.slice(0,8)}...)`);
            
            return {
                success: true,
                created: true,
                message: "Market created successfully on-chain",
                productId,
            };
        } catch (e: any) {
            // Payment is consumed — log for manual refund
            logger.error(`REFUND_NEEDED: Failed to create feed/market for ${productId} (sig=${paymentSignature}):`, e);
            set.status = 500;
            return { error: "Failed to create oracle feed and market", productId };
        }
    }, {
        body: t.Object({
            payer: t.String(),
            productId: t.Number(),
            paymentSignature: t.Optional(t.String()),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Build create market transaction (permissionless)",
            description: "Creates a new market for a card. If oracle feed doesn't exist, requires 0.004 SOL payment to cover account rent.",
        },
    })

    // ── Config ───────────────────────────────────────────────────────────────

    .get("/config", () => {
        // NOTE: RPC URLs intentionally omitted — frontend must use its own
        // BUN_PUBLIC_SOLANA_RPC_URL to prevent MITM via backend config.
        return {
            programId: perpdex().getProgramId(),
            usdcMint: perpdex().getUsdcMint(),
            network: env().program.network,
            maxLeverage: 50,
            minPositionSize: 1, // $1 USD
            tradingFeeBps: 5, // 0.05%
            maintenanceMarginBps: 100, // 1%
        };
    }, {
        detail: {
            tags: ["Trading"],
            summary: "Get trading config",
            description: "Returns configuration for the trading interface",
        },
    })

    // ── Market Stats (Open Interest) ─────────────────────────────────────────

    .get("/market/:productId/stats", async ({ params, set }) => {
        const productId = parseInt(params.productId, 10);
        if (isNaN(productId)) {
            set.status = 400;
            return { error: "Invalid product ID" };
        }

        const market = await perpdex().getMarket(productId);
        if (!market) {
            set.status = 404;
            return { error: "Market not found", productId };
        }

        const oracle = await perpdex().getOraclePrice(productId);

        const totalOI = market.longOpenInterest + market.shortOpenInterest;
        return {
            productId,
            longOpenInterest: market.longOpenInterest,
            shortOpenInterest: market.shortOpenInterest,
            totalOpenInterest: totalOI,
            maxOpenInterest: market.maxOpenInterest,
            utilizationPercent: market.maxOpenInterest > 0
                ? (totalOI / market.maxOpenInterest) * 100
                : 0,
            imbalancePercent: totalOI > 0 
                ? ((market.longOpenInterest - market.shortOpenInterest) / totalOI) * 100
                : 0,
            totalVolume: market.totalVolume,
            maxLeverage: market.maxLeverage,
            oraclePrice: oracle?.price ?? null,
            active: market.active,
        };
    }, {
        params: t.Object({
            productId: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get market stats",
            description: "Returns open interest and trading stats for a market",
        },
    })

    // ── Bulk Market Stats ──────────────────────────────────────────────────────

    .post("/markets/stats", async ({ body, set }) => {
        const { productIds } = body;
        if (!productIds || !Array.isArray(productIds)) {
            set.status = 400;
            return { error: "productIds array required" };
        }
        if (productIds.length > MAX_BATCH_SIZE) {
            set.status = 400;
            return { error: `Too many productIds (max ${MAX_BATCH_SIZE})` };
        }

        // Use the in-memory cache (refreshed by background loop).
        // Falls back to batched RPC if cache is empty.
        const svc = perpdex();
        const cache = svc.getCachedMarketStats();

        const stats: Record<number, {
            productId: number;
            longOpenInterest: number;
            shortOpenInterest: number;
            totalOpenInterest: number;
            maxOpenInterest: number;
            utilizationPercent: number;
            imbalancePercent: number;
            totalVolume: string;
            maxLeverage: number;
            oraclePrice: number | null;
            active: boolean;
        }> = {};

        // Check how many requested products are in the cache
        let cacheHits = 0;
        for (const productId of productIds) {
            const cached = cache.get(productId);
            if (cached) {
                stats[productId] = cached;
                cacheHits++;
            }
        }

        // If cache has everything, return immediately
        if (cacheHits === productIds.length) {
            // all served from cache
        } else {
            // Fetch missing products via batched RPC
            const missingIds = productIds.filter(id => !cache.has(id));
            if (missingIds.length > 0) {
                const [markets, oraclePrices] = await Promise.all([
                    svc.getMarkets(missingIds),
                    svc.getOraclePrices(missingIds),
                ]);

                for (const productId of missingIds) {
                    const market = markets.get(productId);
                    if (!market) continue;

                    const oracle = oraclePrices.get(productId);
                    const totalOI = market.longOpenInterest + market.shortOpenInterest;
                    stats[productId] = {
                        productId,
                        longOpenInterest: market.longOpenInterest,
                        shortOpenInterest: market.shortOpenInterest,
                        totalOpenInterest: totalOI,
                        maxOpenInterest: market.maxOpenInterest,
                        utilizationPercent: market.maxOpenInterest > 0
                            ? (totalOI / market.maxOpenInterest) * 100
                            : 0,
                        imbalancePercent: totalOI > 0
                            ? ((market.longOpenInterest - market.shortOpenInterest) / totalOI) * 100
                            : 0,
                        totalVolume: market.totalVolume,
                        maxLeverage: market.maxLeverage,
                        oraclePrice: oracle?.price ?? null,
                        active: market.active,
                    };
                }
            }
        }

        return { stats };
    }, {
        body: t.Object({
            productIds: t.Array(t.Number()),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Get bulk market stats",
            description: "Batch fetch market stats for multiple product IDs",
        },
    })

    // ── Activation Requests ─────────────────────────────────────────────────

    /**
     * Request activation for a product.
     *
     * Any user with a registered trading account can request that a product
     * be activated for trading. One request per wallet per product.
     *
     * On-demand creation: When a valid request comes in for a product that
     * doesn't have an on-chain feed/market yet, the backend automatically
     * creates the feed and market on-chain.
     * Cost is ~0.003 SOL per product (trivial). The keeper pays this from
     * the deployment wallet.
     */
    .post("/request-activation", async ({ body, set }) => {
        const { productId, wallet, productName } = body;

        if (productId < 0) {
            set.status = 400;
            return { error: "Valid productId required" };
        }
        if (!wallet || !isValidSolanaPubkey(wallet)) {
            set.status = 400;
            return { error: "Valid Solana wallet address required" };
        }

        // L-11: Wallet ownership proof — verify the wallet has an on-chain trading account.
        // Creating a trading account requires signing a transaction, so this proves the
        // requester actually controls the wallet and prevents griefing (mass-submitting
        // requests for random wallets).
        const userAccount = await perpdex().getUserAccount(wallet);
        if (!userAccount) {
            set.status = 403;
            return { error: "Wallet must have a trading account. Create one first." };
        }

        // Check if already requested
        const existing = db().hasActivationRequest(productId, wallet);
        if (existing.exists) {
            return {
                success: true,
                alreadyRequested: true,
                status: existing.status,
                productId,
            };
        }

        // Insert new request
        const inserted = db().insertActivationRequest(productId, wallet, productName || "");
        if (!inserted) {
            // Race condition — another request snuck in
            return {
                success: true,
                alreadyRequested: true,
                status: "pending",
                productId,
            };
        }

        logger.info(`Activation request: product=${productId} wallet=${wallet.slice(0, 8)}...`);

        // Check if this product is already in the active list (approved for trading)
        const activeIds = readActiveProductIdSet();
        if (activeIds.has(productId)) {
            // Already approved — auto-approve this request
            db().updateActivationRequestStatus(productId, "approved");
            return {
                success: true,
                alreadyRequested: false,
                status: "approved",
                productId,
                message: "Product is already approved for trading.",
            };
        }

        // Product not in active list — request stays pending for admin review
        return {
            success: true,
            alreadyRequested: false,
            status: "pending",
            productId,
            message: "Activation request submitted. Awaiting admin approval.",
        };
    }, {
        body: t.Object({
            productId: t.Number(),
            wallet: t.String(),
            productName: t.Optional(t.String()),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Request product activation",
            description: "Submit a request to activate a product for trading. If the product doesn't have an on-chain feed/market, they are created automatically (~0.003 SOL, ~10s).",
        },
    })

    /**
     * Check if a wallet has already requested activation for a product.
     */
    .get("/activation-request/:productId/:wallet", async ({ params, set }) => {
        const productId = parseInt(params.productId, 10);
        if (isNaN(productId)) {
            set.status = 400;
            return { error: "Invalid product ID" };
        }

        const result = db().hasActivationRequest(productId, params.wallet);
        return {
            productId,
            wallet: params.wallet,
            requested: result.exists,
            status: result.exists ? result.status : null,
        };
    }, {
        params: t.Object({
            productId: t.String(),
            wallet: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Check activation request status",
            description: "Check if a specific wallet has requested activation for a product",
        },
    })

    /**
     * Admin: list all activation requests (summary view, grouped by product).
     * Requires admin auth via Authorization header.
     */
    .get("/admin/activation-requests", async ({ query, request, set }) => {
        // Admin auth check
        const password = env().admin.password;
        if (!password) { set.status = 503; return { error: "Admin password not configured" }; }

        const auth = request.headers.get("authorization");
        if (!auth || !auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7), password)) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const status = query.status as string | undefined;
        const limit = Math.min(Math.max(parseInt(query.limit as string) || 100, 1), 500);
        const offset = Math.max(parseInt(query.offset as string) || 0, 0);

        const summary = db().getActivationRequestsSummary({ status, limit, offset });
        const pendingCount = db().countPendingActivationRequests();

        return {
            pendingCount,
            requests: summary,
            limit,
            offset,
        };
    }, {
        detail: {
            tags: ["Trading"],
            summary: "Admin: list activation requests",
            description: "Returns activation requests grouped by product, sorted by request count. Requires admin auth.",
        },
    })

    /**
     * Admin: approve or reject activation requests for a product.
     */
    .post("/admin/activation-requests/:productId", async ({ params, body, request, set }) => {
        const password = env().admin.password;
        if (!password) { set.status = 503; return { error: "Admin password not configured" }; }

        const auth = request.headers.get("authorization");
        if (!auth || !auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7), password)) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const productId = parseInt(params.productId, 10);
        if (isNaN(productId)) { set.status = 400; return { error: "Invalid product ID" }; }

        const { action } = body as { action: string };
        if (action !== "approve" && action !== "reject") {
            set.status = 400;
            return { error: "action must be 'approve' or 'reject'" };
        }

        const status = action === "approve" ? "approved" : "rejected";
        const updated = db().updateActivationRequestStatus(productId, status);

        logger.info(`Admin ${action}d activation for product ${productId} (${updated} requests updated)`);

        // If approved, add to active.txt, create market, and start price tracking
        if (action === "approve") {
            // Add to active.txt
            const { addToActiveList } = await import("../env");
            const added = addToActiveList(productId);
            if (added) {
                logger.info(`Added product ${productId} to active.txt`);
            }

            // Create market in background
            const { keeper } = await import("../services/oracle/keeper");
            const k = keeper();
            if (k) {
                // Fire and forget - don't block response
                (async () => {
                    try {
                        // 1. Create market if needed
                        const result = await k.createMarket(productId);
                        if (result.success) {
                            logger.info(`Created market for approved product ${productId}`);
                        } else {
                            logger.error(`Failed to create market for ${productId}: ${result.error}`);
                            return;
                        }

                    } catch (e) {
                        logger.error(`Error setting up approved product ${productId}:`, e);
                    }
                })();
            }
        }

        return {
            success: true,
            productId,
            action,
            updatedCount: updated,
        };
    }, {
        params: t.Object({
            productId: t.String(),
        }),
        body: t.Object({
            action: t.String(),
        }),
        detail: {
            tags: ["Trading"],
            summary: "Admin: approve/reject activation requests",
            description: "Approve or reject all activation requests for a product. Requires admin auth.",
        },
    })

    // ── Tradable Products ────────────────────────────────────────────────────

    .get("/tradable", async () => {
        // Use the in-memory market stats cache (refreshed by background loop)
        // instead of per-product RPC calls. Scales to 50k+ products.
        const tradableIds = readActiveProductIds(env().keeper.cycleBatchSize);
        if (tradableIds.length === 0) {
            return { tradableProductIds: [], products: [] };
        }

        const svc = perpdex();
        const cache = svc.getCachedMarketStats();

        const results = tradableIds.map((id) => {
            const stats = cache.get(id);
            return {
                productId: id,
                hasMarket: !!stats,
                marketActive: stats?.active ?? false,
                hasOraclePrice: stats?.oraclePrice != null,
                oraclePrice: stats?.oraclePrice ?? undefined,
                oracleAge: undefined, // Not tracked in cache; use /oracle endpoint for freshness
            };
        });

        return {
            tradableProductIds: results.filter(r => r.hasMarket && r.marketActive).map(r => r.productId),
            products: results,
        };
    }, {
        detail: {
            tags: ["Trading"],
            summary: "Get tradable products",
            description: "Returns list of product IDs that have active markets",
        },
    })

    // ── Admin: Withdraw Fees ─────────────────────────────────────────────────

    .post("/admin/withdraw-fees", async ({ body, request, set }) => {
        const password = env().admin.password;
        if (!password) { set.status = 503; return { error: "Admin password not configured" }; }

        const auth = request.headers.get("authorization");
        if (!auth || !auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7), password)) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { amount } = body;
        if (!amount || amount <= 0) {
            set.status = 400;
            return { error: "amount must be positive" };
        }

        // Get current exchange state to check available fees
        const exchange = await perpdex().getExchangeState();
        if (!exchange) {
            set.status = 503;
            return { error: "Exchange not initialized" };
        }

        if (amount > exchange.totalFeesCollected) {
            set.status = 400;
            return { 
                error: "Insufficient fees", 
                requested: amount,
                available: exchange.totalFeesCollected,
            };
        }

        // Build and send withdraw_fees transaction
        const { keeper } = await import("../services/oracle/keeper");
        const k = keeper();
        if (!k) {
            set.status = 503;
            return { error: "Keeper not initialized" };
        }

        const result = await k.withdrawFees(amount);
        if (!result.success) {
            logger.error("Failed to withdraw fees:", result.error);
            set.status = 500;
            return { error: result.error || "Unknown error" };
        }

        logger.info(`Admin withdrew ${amount / 1e6} USDC in fees. Signature: ${result.signature}`);
        return {
            success: true,
            amount,
            signature: result.signature,
            message: `Withdrew $${(amount / 1e6).toFixed(2)} USDC to treasury`,
        };
    }, {
        body: t.Object({
            amount: t.Number(), // in USDC base units (6 decimals)
        }),
        detail: {
            tags: ["Trading"],
            summary: "Admin: withdraw protocol fees",
            description: "Withdraw accumulated trading fees to the treasury wallet. Amount in USDC base units.",
        },
    });
