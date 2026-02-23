/**
 * Referral Program Routes
 *
 * Pre-launch referral system:
 *   - Track signups via referral codes
 *   - Leaderboard of top referrers (truncated wallets)
 *   - Stats for individual wallets (requires wallet signature)
 *
 * Security:
 *   - No unauthenticated endpoint to enumerate or generate referral codes
 *   - Stats/code retrieval requires Ed25519 signature proving wallet ownership
 *   - Signup requires Ed25519 signature to prevent fake referral inflation
 *   - Leaderboard only shows truncated wallet addresses
 *   - Signatures include a timestamp to prevent replay (5-minute window)
 */

import { Elysia, t } from "elysia";
import { db } from "../services/db";
import { perpdex } from "../services/perpdex";
import { log } from "../log";
import { PublicKey } from "@solana/web3.js";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

const L = log("referral");

// noble/ed25519 v3 requires setting the sha512 sync hash
ed.hashes.sha512 = (...msgs: Uint8Array[]) => {
    const h = sha512.create();
    for (const m of msgs) h.update(m);
    return h.digest();
};

/** Signature validity window (5 minutes) */
const SIG_MAX_AGE_MS = 5 * 60 * 1000;

/** Basic Solana pubkey validation (base58, 32-44 chars) */
function isValidWallet(s: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/** Truncate wallet for public display: "AbCd...xYzW" */
function truncateWallet(wallet: string): string {
    if (wallet.length <= 10) return wallet;
    return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

/**
 * Verify an Ed25519 signature from a Solana wallet.
 *
 * @param wallet   Base58 public key
 * @param message  The exact message string that was signed
 * @param signature Base64-encoded signature
 * @returns true if valid
 */
async function verifyWalletSignature(
    wallet: string,
    message: string,
    signature: string,
): Promise<boolean> {
    try {
        const pubkey = new PublicKey(wallet);
        const msgBytes = new TextEncoder().encode(message);
        const sigBytes = Buffer.from(signature, "base64");
        if (sigBytes.length !== 64) return false;
        return await ed.verifyAsync(sigBytes, msgBytes, pubkey.toBytes());
    } catch {
        return false;
    }
}

/**
 * Validate that a signed timestamp is within the allowed window.
 */
function isTimestampValid(timestamp: number): boolean {
    const now = Date.now();
    const age = Math.abs(now - timestamp);
    return age <= SIG_MAX_AGE_MS;
}

export const referralRoutes = new Elysia({ prefix: "/api/referral" })

    // ── Get referral stats + code for own wallet (requires signature) ───
    .post("/stats", async ({ body, set }) => {
        const { wallet, timestamp, signature } = body;

        if (!isValidWallet(wallet)) {
            set.status = 400;
            return { error: "Invalid wallet address" };
        }

        if (!isTimestampValid(timestamp)) {
            set.status = 401;
            return { error: "Signature expired" };
        }

        const message = `TradeX-referral-stats:${wallet}:${timestamp}`;
        const valid = await verifyWalletSignature(wallet, message, signature);
        if (!valid) {
            set.status = 401;
            return { error: "Invalid signature" };
        }

        const stats = db().getReferralStats(wallet);
        const code = db().getOrCreateReferralCode(wallet);
        const isReferred = db().isAlreadyReferred(wallet);
        const referredBy = db().getReferredBy(wallet);

        // Count active referrals — referred users who have traded (totalFeesPaid > 0)
        // and have activity in the past 3 months (open positions with recent lastUpdated)
        let activeReferrals = 0;
        const referredWallets = db().getReferredWallets(wallet);
        if (referredWallets.length > 0) {
            const threeMonthsAgo = Date.now() / 1000 - 90 * 24 * 60 * 60; // unix seconds
            const svc = perpdex();

            // Check each referred wallet in parallel (capped to avoid RPC flooding)
            const checks = referredWallets.map(async (rw) => {
                try {
                    const account = await svc.getUserAccount(rw);
                    if (!account || account.totalFeesPaid <= 0) return false;

                    // If they have open positions, check if any were updated recently
                    if (account.openPositionCount > 0) {
                        const positions = await svc.getUserPositions(rw);
                        return positions.some(p => p.lastUpdated >= threeMonthsAgo);
                    }

                    // No open positions but has paid fees — check if any position
                    // was active recently. Since closed positions are deleted on-chain,
                    // we can't check their timestamps. Count them as active if they
                    // have open positions, otherwise inactive.
                    return false;
                } catch {
                    return false;
                }
            });

            const results = await Promise.all(checks);
            activeReferrals = results.filter(Boolean).length;
        }

        return {
            wallet, code, is_referred: isReferred, referred_by: referredBy,
            ...stats,
            active_referrals: activeReferrals,
        };
    }, {
        body: t.Object({
            wallet: t.String(),
            timestamp: t.Number(),
            signature: t.String(),
        }),
        detail: {
            tags: ["Referral"],
            summary: "Get referral stats for own wallet",
            description: "Returns referral code, total referrals, total points. Requires wallet signature to prove ownership.",
        },
    })

    // ── Record a referral signup (requires signature) ───────────────────
    .post("/signup", async ({ body, set }) => {
        const { wallet, code, timestamp, signature } = body;

        if (!isValidWallet(wallet)) {
            set.status = 400;
            return { error: "Invalid wallet address" };
        }

        if (!code || code.length < 4 || code.length > 10) {
            set.status = 400;
            return { error: "Invalid referral code" };
        }

        if (!isTimestampValid(timestamp)) {
            set.status = 401;
            return { error: "Signature expired" };
        }

        // Verify wallet ownership
        const message = `TradeX-referral-signup:${wallet}:${code}:${timestamp}`;
        const valid = await verifyWalletSignature(wallet, message, signature);
        if (!valid) {
            set.status = 401;
            return { error: "Invalid signature" };
        }

        // Look up the referrer
        const referrerWallet = db().getReferrerByCode(code);
        if (!referrerWallet) {
            set.status = 404;
            return { error: "Referral code not found" };
        }

        // Can't refer yourself
        if (referrerWallet === wallet) {
            set.status = 400;
            return { error: "Cannot refer yourself" };
        }

        // Check if already referred
        if (db().isAlreadyReferred(wallet)) {
            set.status = 409;
            return { error: "Wallet already has a referrer" };
        }

        const success = db().recordReferralSignup(wallet, referrerWallet, code);
        if (!success) {
            set.status = 409;
            return { error: "Wallet already has a referrer" };
        }

        L.info(`Referral signup: ${wallet} referred by ${referrerWallet} (code: ${code})`);
        return { success: true };
    }, {
        body: t.Object({
            wallet: t.String(),
            code: t.String(),
            timestamp: t.Number(),
            signature: t.String(),
        }),
        detail: {
            tags: ["Referral"],
            summary: "Record a referral signup",
            description: "Records that a wallet was referred by a code. Requires wallet signature. Awards 100 points to the referrer.",
        },
    })

    // ── Leaderboard (public, but truncated wallets) ─────────────────────
    .get("/leaderboard", ({ query }) => {
        const limit = Math.min(Math.max(parseInt(query.limit ?? "10"), 1), 100);
        const leaderboard = db().getReferralLeaderboard(limit);
        const wallet = query.wallet;

        // Truncate wallet addresses for public display
        const result: {
            leaderboard: Array<{ wallet: string; total_referrals: number }>;
            your_rank?: number | null;
            your_referrals?: number;
        } = {
            leaderboard: leaderboard.map((entry) => ({
                wallet: truncateWallet(entry.wallet),
                total_referrals: entry.total_referrals,
            })),
        };

        // If a wallet is provided, return their rank + referral count
        if (wallet && isValidWallet(wallet)) {
            result.your_rank = db().getReferralRank(wallet);
            const stats = db().getReferralStats(wallet);
            result.your_referrals = stats.total_referrals;
        }

        return result;
    }, {
        query: t.Object({
            limit: t.Optional(t.String()),
            wallet: t.Optional(t.String()),
        }),
        detail: {
            tags: ["Referral"],
            summary: "Get referral leaderboard",
            description: "Returns top referrers ranked by referrals. Wallet addresses are truncated for privacy. Optionally pass ?wallet= to get your rank.",
        },
    });
