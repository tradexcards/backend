/**
 * Admin Dashboard Routes — /api/admin
 *
 * Password-protected admin endpoints for full platform visibility.
 * All endpoints require `Authorization: Bearer <ADMIN_PASSWORD>`.
 *
 * Endpoints:
 *   GET /overview          Aggregate stats (users, positions, volume, fees, loops, WS clients)
 *   GET /cards             All cards with activation/market/pricing status
 *   GET /activation-requests  All activation requests (pending/approved/rejected)
 *   GET /referrals         All referral codes and signups (full wallets)
 *   GET /users/:wallet     Single user: account balance, positions, PnL
 *   GET /positions         All open positions across all users
 *   GET /exchange          Full exchange state + market states + vault balance
 */

import { Elysia, t } from "elysia";
import { env, readActiveProductIds } from "../env";
import { db } from "../services/db";
import { perpdex } from "../services/perpdex";
import { loops } from "../services/loops";
import { keeper } from "../services/oracle/keeper";
import { tcgplayer } from "../services/tcgplayer";
import { analyzer } from "../services/analyzer";
import { getClientCount as getWsClientCount } from "./ws";
import { timingSafeEqual } from "../utils/crypto";
import { log } from "../log";
import { PublicKey } from "@solana/web3.js";

const L = log("admin");

// ── Auth helper ─────────────────────────────────────────────────────────────

function checkAdminAuth(request: Request): string | null {
    const password = env().admin.password;
    if (!password) return "Admin password not configured";

    const auth = request.headers.get("authorization");
    if (!auth) return "Authorization header required";

    if (auth.startsWith("Bearer ")) {
        if (!timingSafeEqual(auth.slice(7), password)) return "Invalid admin token";
        return null;
    }

    if (auth.startsWith("Basic ")) {
        try {
            const decoded = atob(auth.slice(6));
            const [, pass] = decoded.split(":");
            if (!pass || !timingSafeEqual(pass, password)) return "Invalid admin credentials";
            return null;
        } catch {
            return "Invalid Basic auth encoding";
        }
    }

    return "Unsupported authorization scheme";
}

// ── Route plugin ────────────────────────────────────────────────────────────

export const adminRoutes = new Elysia({ prefix: "/api/admin" })

    // Global auth guard for all admin endpoints
    .onBeforeHandle(({ request, set }) => {
        const authErr = checkAdminAuth(request);
        if (authErr) {
            set.status = 401;
            return { error: authErr };
        }
    })

    // ── GET /overview ───────────────────────────────────────────────────────
    .get("/overview", async () => {
        const svc = perpdex();
        const exchangeState = await svc.getExchangeState();
        const loopStatus = loops().getStatus();
        const statsCache = svc.getCachedMarketStats();
        const tableCounts = db().getTableCounts();
        const dbStats = db().getDbStats();
        const pendingActivations = db().countPendingActivationRequests();

        // Referral totals
        const referralCodes = db().getAllReferralCodes();
        const referralSignups = db().getAllReferralSignups();
        const totalReferralPoints = referralSignups.reduce((sum, s) => sum + s.points, 0);

        // Keeper stats
        let keeperStats: any = null;
        try {
            const k = keeper();
            if (k) {
                keeperStats = {
                    running: k.isRunning(),
                    stats: k.getStats(),
                    treasuryWallet: k.getTreasuryWallet().toBase58(),
                };
            }
        } catch { /* keeper not initialized */ }

        return {
            timestamp: Date.now(),
            exchange: exchangeState ? {
                admin: exchangeState.admin,
                marketCount: exchangeState.marketCount,
                totalDeposits: exchangeState.totalDeposits,
                totalVolume: exchangeState.totalVolume,
                totalFeesCollected: exchangeState.totalFeesCollected,
                insuranceBalance: exchangeState.insuranceBalance,
                paused: exchangeState.paused,
            } : null,
            markets: {
                cachedCount: statsCache.size,
                cacheAge: svc.getMarketStatsCacheAge(),
            },
            loops: loopStatus,
            wsClients: getWsClientCount(),
            database: {
                tables: tableCounts,
                sizeMB: Math.round(dbStats.totalSizeBytes / 1024 / 1024 * 100) / 100,
            },
            referrals: {
                totalCodes: referralCodes.length,
                totalSignups: referralSignups.length,
                totalPoints: totalReferralPoints,
            },
            activations: {
                pendingCount: pendingActivations,
            },
            keeper: keeperStats,
        };
    }, {
        detail: {
            tags: ["Admin"],
            summary: "Admin overview",
            description: "Aggregate platform stats for the admin dashboard",
        },
    })

    // ── GET /cards ──────────────────────────────────────────────────────────
    .get("/cards", async () => {
        const activeIds = readActiveProductIds(200);
        const activeSet = new Set(activeIds);
        const client = tcgplayer();
        const ana = analyzer();
        const svc = perpdex();
        const statsCache = svc.getCachedMarketStats();

        const result = await ana.getCached();
        const analysisMap = new Map<number, any>();
        if (result) {
            for (const card of result.all_cards) {
                analysisMap.set(card.product_id, card);
            }
        }

        const k = keeper();
        const erPrices = k ? k.getAllErPrices() : new Map<number, { priceUsd: number; publishedAt: number }>();

        const cards = await Promise.all(
            activeIds.map(async (productId) => {
                const info = await client.getCachedProductInfoRaw(productId);
                const pricing = await client.getCachedPricingRaw(productId);
                const analysis = analysisMap.get(productId);
                const marketStats = statsCache.get(productId);
                const er = erPrices.get(productId);

                return {
                    product_id: productId,
                    product_name: info?.product_name ?? analysis?.product_name ?? `Product ${productId}`,
                    set_name: info?.set_name ?? "",
                    rarity: info?.rarity_name ?? "",
                    image_url: info?.image_url ?? null,
                    is_active: activeSet.has(productId),
                    pricing: pricing ? {
                        market_price: pricing.market_price,
                        lowest_price: pricing.lowest_price,
                        listings: pricing.listings,
                        sellers: pricing.sellers,
                        fetched_at: pricing.fetched_at,
                    } : null,
                    analysis: analysis ? {
                        activity_score: analysis.activity_score,
                        change_24h: analysis.change_24h,
                        change_30d: analysis.change_30d,
                        current_price: analysis.current_price,
                    } : null,
                    market: marketStats ? {
                        longOI: marketStats.longOpenInterest,
                        shortOI: marketStats.shortOpenInterest,
                        totalVolume: marketStats.totalVolume,
                        maxLeverage: marketStats.maxLeverage,
                        active: marketStats.active,
                    } : null,
                    oracle: er ? {
                        price: er.priceUsd,
                        publishedAt: er.publishedAt,
                        ageSeconds: Math.round((Date.now() - er.publishedAt) / 1000),
                    } : null,
                };
            }),
        );

        return { total: cards.length, cards };
    }, {
        detail: {
            tags: ["Admin"],
            summary: "All cards with status",
            description: "All active cards with pricing, market, and oracle status",
        },
    })

    // ── GET /activation-requests ────────────────────────────────────────────
    .get("/activation-requests", ({ query }) => {
        const status = query.status as string | undefined;
        const limit = Math.min(Math.max(parseInt(query.limit ?? "200"), 1), 1000);
        const offset = Math.max(parseInt(query.offset ?? "0"), 0);

        const requests = db().getActivationRequests({ status, limit, offset });
        const summary = db().getActivationRequestsSummary({ status, limit, offset });

        return {
            total: requests.length,
            requests,
            summary,
        };
    }, {
        query: t.Object({
            status: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
        }),
        detail: {
            tags: ["Admin"],
            summary: "Activation requests",
            description: "All activation requests with full detail (admin view — full wallets)",
        },
    })

    // ── GET /referrals ──────────────────────────────────────────────────────
    .get("/referrals", () => {
        const codes = db().getAllReferralCodes();
        const signups = db().getAllReferralSignups();
        const leaderboard = db().getReferralLeaderboard(100);

        // Build a map of wallet -> stats for quick lookup
        const statsMap = new Map<string, { total_referrals: number; total_points: number }>();
        for (const entry of leaderboard) {
            statsMap.set(entry.wallet, { total_referrals: entry.total_referrals, total_points: entry.total_points });
        }

        const codesWithStats = codes.map(c => ({
            ...c,
            stats: statsMap.get(c.wallet) ?? { total_referrals: 0, total_points: 0 },
        }));

        return {
            total_codes: codes.length,
            total_signups: signups.length,
            total_points: signups.reduce((sum, s) => sum + s.points, 0),
            codes: codesWithStats,
            signups,
        };
    }, {
        detail: {
            tags: ["Admin"],
            summary: "All referral data",
            description: "All referral codes and signups with full wallet addresses (admin only)",
        },
    })

    // ── GET /users/:wallet ──────────────────────────────────────────────────
    .get("/users/:wallet", async ({ params }) => {
        const { wallet } = params;

        // Validate wallet format
        try {
            new PublicKey(wallet);
        } catch {
            return { error: "Invalid wallet address" };
        }

        const svc = perpdex();
        const [userAccount, positions] = await Promise.all([
            svc.getUserAccount(wallet),
            svc.getUserPositions(wallet),
        ]);

        // Referral info
        const referralStats = db().getReferralStats(wallet);
        const isReferred = db().isAlreadyReferred(wallet);

        // Get oracle prices for positions to compute PnL
        const k = keeper();
        const positionsWithPnl = positions.map(pos => {
            let currentPrice: number | null = null;
            if (k) {
                const cached = k.getCachedPrice(pos.productId);
                if (cached) currentPrice = cached.priceUsd;
            }
            return {
                ...pos,
                currentPrice,
            };
        });

        return {
            wallet,
            account: userAccount,
            positions: positionsWithPnl,
            referral: {
                ...referralStats,
                is_referred: isReferred,
            },
        };
    }, {
        detail: {
            tags: ["Admin"],
            summary: "User details",
            description: "Single user account, positions, and referral info",
        },
    })

    // ── GET /positions ──────────────────────────────────────────────────────
    .get("/positions", async () => {
        // Scan ALL position accounts on-chain
        const svc = perpdex();

        try {
            const { Connection, PublicKey: PK } = await import("@solana/web3.js");
            const conn = new Connection(env().solana.rpcUrl, "confirmed");
            const programId = new PK(env().program.programId);

            // Position discriminator from program
            const POSITION_DISCRIMINATOR_BS58 = "VZMoMoKSX7H";

            const accounts = await conn.getProgramAccounts(programId, {
                filters: [
                    { memcmp: { offset: 0, bytes: POSITION_DISCRIMINATOR_BS58 } },
                ],
            });

            const POSITION_MIN_SIZE = 105;
            const positions: any[] = [];

            const k = keeper();

            for (const { pubkey, account } of accounts) {
                const data = account.data.slice(8);
                if (data.length < POSITION_MIN_SIZE) continue;

                const productId = data.readUInt32LE(32);
                let currentPrice: number | null = null;
                if (k) {
                    const cached = k.getCachedPrice(productId);
                    if (cached) currentPrice = cached.priceUsd;
                }

                positions.push({
                    address: pubkey.toString(),
                    owner: new PK(data.slice(0, 32)).toString(),
                    productId,
                    side: data[36] === 0 ? "long" : "short",
                    size: Number(data.readBigUInt64LE(37)) / 1e6,
                    entryPrice: Number(data.readBigUInt64LE(45)) / 1e8,
                    leverage: data.readUInt32LE(53),
                    margin: Number(data.readBigUInt64LE(57)) / 1e6,
                    liquidationPrice: Number(data.readBigUInt64LE(65)) / 1e8,
                    realizedPnl: Number(data.readBigInt64LE(73)) / 1e6,
                    openedAt: Number(data.readBigInt64LE(89)),
                    lastUpdated: Number(data.readBigInt64LE(97)),
                    currentPrice,
                });
            }

            return { total: positions.length, positions };
        } catch (e: any) {
            L.error("Failed to scan all positions:", e);
            return { total: 0, positions: [], error: e.message };
        }
    }, {
        detail: {
            tags: ["Admin"],
            summary: "All open positions",
            description: "All open positions across all users (on-chain scan)",
        },
    })

    // ── GET /exchange ───────────────────────────────────────────────────────
    .get("/exchange", async () => {
        const svc = perpdex();
        const exchangeState = await svc.getExchangeState();
        const activeIds = readActiveProductIds(200);
        const markets = await svc.getMarketsBatch(activeIds);

        const marketList = [...markets.entries()].map(([productId, market]) => {
            const info = db().getProduct(productId);
            return {
                ...market,
                productName: info?.product_name ?? `Product ${productId}`,
            };
        });

        return {
            exchangeState,
            markets: marketList,
            totalMarkets: marketList.length,
        };
    }, {
        detail: {
            tags: ["Admin"],
            summary: "Exchange state",
            description: "Full exchange state + all market states",
        },
    });
