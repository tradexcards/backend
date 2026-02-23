/**
 * PerpDex Service
 * 
 * Provides read-only access to the perpetual DEX on-chain state.
 * Trading transactions are constructed here but signed on the frontend.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "../../env";
import { log } from "../../log";
import { keeper } from "../index";

// SPL Token Program ID (well-known constant)
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Read a u128 (16 bytes, little-endian) from a Buffer.
 * Combines the low and high u64 halves into a BigInt, then converts to a
 * USDC-scaled string (divided by 1e6). Returns as string to avoid Number
 * precision loss on large volumes.
 */
function readU128AsVolumeString(data: Buffer, offset: number): string {
    const lo = data.readBigUInt64LE(offset);
    const hi = data.readBigUInt64LE(offset + 8);
    const full = (hi << 64n) | lo;
    // Convert to USDC units (6 decimals) as a string to avoid precision loss
    const wholePart = full / 1_000_000n;
    const fracPart = full % 1_000_000n;
    if (fracPart === 0n) return wholePart.toString();
    return `${wholePart}.${fracPart.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

// ── Constants (loaded from env at init time) ─────────────────────────────────

// Lazy-initialized singletons to avoid reading env before it's ready
let _PROGRAM_ID: PublicKey | null = null;
let _USDC_MINT: PublicKey | null = null;

function PROGRAM_ID(): PublicKey {
    if (!_PROGRAM_ID) _PROGRAM_ID = new PublicKey(env().program.programId);
    return _PROGRAM_ID;
}

function USDC_MINT(): PublicKey {
    if (!_USDC_MINT) _USDC_MINT = new PublicKey(env().program.usdcMint);
    return _USDC_MINT;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExchangeState {
    admin: string;
    usdcMint: string;
    vault: string;
    insuranceFund: string;
    marketCount: number;
    totalDeposits: number;
    totalVolume: string;
    totalFeesCollected: number;
    insuranceBalance: number;
    paused: boolean;
}

export interface MarketState {
    productId: number;
    oraclePriceFeed: string;
    maxLeverage: number;
    maxOpenInterest: number;
    longOpenInterest: number;
    shortOpenInterest: number;
    totalVolume: string;
    lastFundingTime: number;
    cumulativeFundingRateLong: number;
    cumulativeFundingRateShort: number;
    active: boolean;
}

export interface Position {
    /** Position account pubkey */
    address: string;
    owner: string;
    productId: number;
    side: "long" | "short";
    size: number;
    entryPrice: number;
    leverage: number;
    margin: number;
    liquidationPrice: number;
    realizedPnl: number;
    entryFundingRate: number;
    openedAt: number;
    lastUpdated: number;
}

/** Position with computed PnL fields for AI agent consumption */
export interface PositionWithPnL extends Position {
    computed: {
        /** Current oracle price */
        currentPrice: number;
        /** Unrealized profit/loss in USD */
        unrealizedPnl: number;
        /** Unrealized PnL as percentage of margin */
        unrealizedPnlPercent: number;
        /** Current margin ratio (margin / (margin + unrealizedPnl)) */
        marginRatio: number;
        /** Effective leverage after accounting for PnL */
        effectiveLeverage: number;
        /** Percentage price move until liquidation */
        distanceToLiquidation: number;
        /** Estimated closing fee (0.05% of size) */
        estimatedClosingFee: number;
        /** Net PnL after estimated closing fee */
        netPnl: number;
        /** Time position has been open */
        holdingPeriodSeconds: number;
        /** Risk status: safe (>5%), warning (2-5%), danger (<2%) */
        riskStatus: "safe" | "warning" | "danger";
    };
}

/**
 * Compute PnL and risk metrics for a position given the current oracle price.
 */
export function computePositionPnL(position: Position, currentPrice: number): PositionWithPnL["computed"] {
    const { side, size, entryPrice, margin, liquidationPrice, openedAt } = position;
    
    // Calculate unrealized PnL
    let unrealizedPnl: number;
    if (side === "long") {
        unrealizedPnl = size * (currentPrice - entryPrice) / entryPrice;
    } else {
        unrealizedPnl = size * (entryPrice - currentPrice) / entryPrice;
    }
    
    // PnL percentage relative to margin
    const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;
    
    // Margin ratio
    const equity = margin + unrealizedPnl;
    const marginRatio = equity > 0 ? margin / equity : 0;
    
    // Effective leverage
    const effectiveLeverage = equity > 0 ? size / equity : 0;
    
    // Distance to liquidation (percentage)
    let distanceToLiquidation: number;
    if (side === "long") {
        distanceToLiquidation = currentPrice > 0 
            ? ((currentPrice - liquidationPrice) / currentPrice) * 100 
            : 0;
    } else {
        distanceToLiquidation = liquidationPrice > 0 
            ? ((liquidationPrice - currentPrice) / liquidationPrice) * 100 
            : 0;
    }
    distanceToLiquidation = Math.max(0, distanceToLiquidation);
    
    // Estimated closing fee (0.05% = 5 bps)
    const estimatedClosingFee = size * 0.0005;
    
    // Net PnL after fees
    const netPnl = unrealizedPnl - estimatedClosingFee;
    
    // Holding period
    const holdingPeriodSeconds = Math.floor(Date.now() / 1000) - openedAt;
    
    // Risk status based on distance to liquidation
    let riskStatus: "safe" | "warning" | "danger";
    if (distanceToLiquidation > 5) {
        riskStatus = "safe";
    } else if (distanceToLiquidation > 2) {
        riskStatus = "warning";
    } else {
        riskStatus = "danger";
    }
    
    return {
        currentPrice: Math.round(currentPrice * 100) / 100,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 100) / 100,
        marginRatio: Math.round(marginRatio * 1000) / 1000,
        effectiveLeverage: Math.round(effectiveLeverage * 100) / 100,
        distanceToLiquidation: Math.round(distanceToLiquidation * 100) / 100,
        estimatedClosingFee: Math.round(estimatedClosingFee * 100) / 100,
        netPnl: Math.round(netPnl * 100) / 100,
        holdingPeriodSeconds,
        riskStatus,
    };
}

export interface UserAccount {
    owner: string;
    balance: number;
    totalDeposited: number;
    totalWithdrawn: number;
    totalRealizedPnl: number;
    totalFeesPaid: number;
    openPositionCount: number;
    positions: Position[];
}

export interface OraclePrice {
    productId: number;
    price: number;
    updatedAt: number;
    ageSeconds: number;
}

// ── PDA Helpers ──────────────────────────────────────────────────────────────

function u32LE(n: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n);
    return buf;
}

function findPDA(programId: PublicKey, ...seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(seeds, programId);
}

export function getExchangePDA(): PublicKey {
    return findPDA(PROGRAM_ID(), Buffer.from("exchange"))[0];
}

export function getVaultPDA(): PublicKey {
    return findPDA(PROGRAM_ID(), Buffer.from("vault"))[0];
}

export function getInsuranceFundPDA(): PublicKey {
    return findPDA(PROGRAM_ID(), Buffer.from("insurance"))[0];
}

export function getMarketPDA(productId: number): PublicKey {
    return findPDA(PROGRAM_ID(), Buffer.from("market"), u32LE(productId))[0];
}

export function getUserAccountPDA(owner: PublicKey): PublicKey {
    return findPDA(PROGRAM_ID(), Buffer.from("user_account"), owner.toBuffer())[0];
}

export function getOracleStatePDA(): PublicKey {
    return findPDA(PROGRAM_ID(), Buffer.from("oracle"))[0];
}

/** Sysvar Instructions pubkey: Sysvar1nstructions1111111111111111111111111 */
const SYSVAR_INSTRUCTIONS_PUBKEY = "Sysvar1nstructions1111111111111111111111111";

export function getPositionPDA(owner: PublicKey, productId: number): PublicKey {
    return findPDA(PROGRAM_ID(), Buffer.from("position"), owner.toBuffer(), u32LE(productId))[0];
}

// ── Service ──────────────────────────────────────────────────────────────────

// ── Market Stats Cache Types ─────────────────────────────────────────────────

export interface MarketStatsEntry {
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
}

export class PerpDexService {
    private connection: Connection;
    private fallbackConnection: Connection | null;
    private logger = log("perpdex");

    // ── In-memory market stats cache ─────────────────────────────────────
    private _marketStatsCache = new Map<number, MarketStatsEntry>();
    private _marketStatsCacheUpdatedAt: number = 0;

    constructor() {
        const cfg = env();
        this.connection = new Connection(cfg.solana.rpcUrl, "confirmed");
        this.fallbackConnection = cfg.solana.rpcFallbackUrl
            ? new Connection(cfg.solana.rpcFallbackUrl, "confirmed")
            : null;
        
        if (this.fallbackConnection) {
            this.logger.info(`RPC: primary=${cfg.solana.rpcUrl.replace(/api-key=.*/, "api-key=***")} fallback=${cfg.solana.rpcFallbackUrl}`);
        }
    }

    /**
     * Get a working connection — tries primary first, falls back to secondary.
     * Used for reads that can tolerate slightly stale data.
     */
    private async getConnectionWithFallback(): Promise<Connection> {
        try {
            // Quick health check on primary
            await this.connection.getSlot();
            return this.connection;
        } catch (e) {
            if (this.fallbackConnection) {
                this.logger.warn("Primary RPC failed, using fallback");
                return this.fallbackConnection;
            }
            throw e;
        }
    }

    async init(): Promise<void> {
        // No IDL loading needed — raw binary deserialization throughout
        this.logger.info("PerpDex service initialized");
    }

    // ── Exchange State ───────────────────────────────────────────────────────

    async getExchangeState(): Promise<ExchangeState | null> {
        try {
            const pda = getExchangePDA();
            const info = await this.connection.getAccountInfo(pda);
            if (!info) return null;

            // Parse account data (skip 8-byte discriminator)
            const data = info.data.slice(8);
            
            // Bounds check: ExchangeState is at least 205 bytes after discriminator
            // (5 pubkeys × 32 = 160, + u32 + u64 + u128 + u64 + u64 + bool = 160 + 4 + 8 + 16 + 8 + 8 + 1 = 205)
            const EXCHANGE_MIN_SIZE = 205;
            if (data.length < EXCHANGE_MIN_SIZE) {
                this.logger.error(`Exchange account data too short: ${data.length} < ${EXCHANGE_MIN_SIZE}`);
                return null;
            }

            return {
                admin: new PublicKey(data.slice(0, 32)).toString(),
                // pending_admin at offset 32-63 (not exposed in API)
                usdcMint: new PublicKey(data.slice(64, 96)).toString(),
                vault: new PublicKey(data.slice(96, 128)).toString(),
                insuranceFund: new PublicKey(data.slice(128, 160)).toString(),
                marketCount: data.readUInt32LE(160),
                totalDeposits: Number(data.readBigUInt64LE(164)) / 1e6,
                totalVolume: readU128AsVolumeString(data, 172),
                totalFeesCollected: Number(data.readBigUInt64LE(188)) / 1e6,
                insuranceBalance: Number(data.readBigUInt64LE(196)) / 1e6,
                paused: data[204] === 1,
            };
        } catch (e) {
            this.logger.error("Failed to fetch exchange state:", e);
            return null;
        }
    }

    // ── Market State ─────────────────────────────────────────────────────────

    async getMarket(productId: number): Promise<MarketState | null> {
        try {
            const pda = getMarketPDA(productId);
            const info = await this.connection.getAccountInfo(pda);
            if (!info) return null;

            const data = info.data.slice(8);
            
            // Bounds check: Market is at least 105 bytes after discriminator
            const MARKET_MIN_SIZE = 105;
            if (data.length < MARKET_MIN_SIZE) {
                this.logger.error(`Market account data too short for ${productId}: ${data.length} < ${MARKET_MIN_SIZE}`);
                return null;
            }

            return {
                productId: data.readUInt32LE(0),
                oraclePriceFeed: new PublicKey(data.slice(4, 36)).toString(),
                maxLeverage: data.readUInt32LE(36),
                maxOpenInterest: Number(data.readBigUInt64LE(40)) / 1e6,
                longOpenInterest: Number(data.readBigUInt64LE(48)) / 1e6,
                shortOpenInterest: Number(data.readBigUInt64LE(56)) / 1e6,
                totalVolume: readU128AsVolumeString(data, 64),
                lastFundingTime: Number(data.readBigInt64LE(80)),
                cumulativeFundingRateLong: Number(data.readBigInt64LE(88)),
                cumulativeFundingRateShort: Number(data.readBigInt64LE(96)),
                active: data[104] === 1,
            };
        } catch (e) {
            this.logger.error(`Failed to fetch market ${productId}:`, e);
            return null;
        }
    }

    async getMarkets(productIds: number[]): Promise<Map<number, MarketState>> {
        return this.getMarketsBatch(productIds);
    }

    // ── User Account ─────────────────────────────────────────────────────────

    async getUserAccount(owner: string): Promise<UserAccount | null> {
        try {
            const ownerPubkey = new PublicKey(owner);
            const pda = getUserAccountPDA(ownerPubkey);
            const info = await this.connection.getAccountInfo(pda);
            if (!info) return null;

            // Skip 8-byte discriminator
            const data = info.data.slice(8);
            
            // New lightweight UserAccount layout (no embedded positions):
            // owner: 32 bytes (Pubkey) - offset 0
            // balance: 8 bytes (u64) - offset 32
            // total_deposited: 8 bytes (u64) - offset 40
            // total_withdrawn: 8 bytes (u64) - offset 48
            // total_realized_pnl: 8 bytes (i64) - offset 56
            // total_fees_paid: 8 bytes (u64) - offset 64
            // open_position_count: 4 bytes (u32) - offset 72
            // Total: 76 bytes

            const USER_ACCOUNT_MIN_SIZE = 76;
            if (data.length < USER_ACCOUNT_MIN_SIZE) {
                this.logger.error(`User account data too short for ${owner}: ${data.length} < ${USER_ACCOUNT_MIN_SIZE}`);
                return null;
            }

            return {
                owner: new PublicKey(data.slice(0, 32)).toString(),
                balance: Number(data.readBigUInt64LE(32)) / 1e6,
                totalDeposited: Number(data.readBigUInt64LE(40)) / 1e6,
                totalWithdrawn: Number(data.readBigUInt64LE(48)) / 1e6,
                totalRealizedPnl: Number(data.readBigInt64LE(56)) / 1e6,
                totalFeesPaid: Number(data.readBigUInt64LE(64)) / 1e6,
                openPositionCount: data.readUInt32LE(72),
                positions: [], // Positions are now fetched separately via getUserPositions()
            };
        } catch (e) {
            this.logger.error(`Failed to fetch user account ${owner}:`, e);
            return null;
        }
    }

    // ── User Positions (Separate PDAs) ────────────────────────────────────────

    /**
     * Fetch all positions for a user using getProgramAccounts.
     * Positions are now separate PDAs with seeds [b"position", owner, product_id]
     */
    async getUserPositions(owner: string): Promise<Position[]> {
        try {
            const ownerPubkey = new PublicKey(owner);
            
            // Position discriminator from program: [0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x17, 0x2b, 0x6c]
            // Base58 encoded: "VZMoMoKSX7H"
            const POSITION_DISCRIMINATOR_BS58 = "VZMoMoKSX7H";
            
            // Fetch all Position accounts where owner matches
            const accounts = await this.connection.getProgramAccounts(PROGRAM_ID(), {
                filters: [
                    // Filter by discriminator (first 8 bytes) - must be base58 encoded
                    { memcmp: { offset: 0, bytes: POSITION_DISCRIMINATOR_BS58 } },
                    // Filter by owner (bytes 8-40, after discriminator)
                    { memcmp: { offset: 8, bytes: ownerPubkey.toBase58() } },
                ],
            });

            const positions: Position[] = [];
            
            const POSITION_MIN_SIZE = 105;

            for (const { pubkey, account } of accounts) {
                const data = account.data.slice(8); // Skip discriminator
                
                // Position layout:
                // owner: 32 bytes (Pubkey) - offset 0
                // product_id: 4 bytes (u32) - offset 32
                // side: 1 byte (enum) - offset 36
                // size: 8 bytes (u64) - offset 37
                // entry_price: 8 bytes (u64) - offset 45
                // leverage: 4 bytes (u32) - offset 53
                // margin: 8 bytes (u64) - offset 57
                // liquidation_price: 8 bytes (u64) - offset 65
                // realized_pnl: 8 bytes (i64) - offset 73
                // entry_funding_rate: 8 bytes (i64) - offset 81
                // opened_at: 8 bytes (i64) - offset 89
                // last_updated: 8 bytes (i64) - offset 97
                // Total: 105 bytes
                
                if (data.length < POSITION_MIN_SIZE) {
                    this.logger.error(`Position account data too short: ${data.length} < ${POSITION_MIN_SIZE}`);
                    continue;
                }

                positions.push({
                    address: pubkey.toString(),
                    owner: new PublicKey(data.slice(0, 32)).toString(),
                    productId: data.readUInt32LE(32),
                    side: data[36] === 0 ? "long" : "short",
                    size: Number(data.readBigUInt64LE(37)) / 1e6,
                    entryPrice: Number(data.readBigUInt64LE(45)) / 1e8,
                    leverage: data.readUInt32LE(53),
                    margin: Number(data.readBigUInt64LE(57)) / 1e6,
                    liquidationPrice: Number(data.readBigUInt64LE(65)) / 1e8,
                    realizedPnl: Number(data.readBigInt64LE(73)) / 1e6,
                    entryFundingRate: Number(data.readBigInt64LE(81)),
                    openedAt: Number(data.readBigInt64LE(89)),
                    lastUpdated: Number(data.readBigInt64LE(97)),
                });
            }

            return positions;
        } catch (e) {
            this.logger.error(`Failed to fetch positions for ${owner}:`, e);
            return [];
        }
    }

    /**
     * Fetch a single position by owner and productId.
     */
    async getPosition(owner: string, productId: number): Promise<Position | null> {
        try {
            const ownerPubkey = new PublicKey(owner);
            const positionPDA = getPositionPDA(ownerPubkey, productId);
            const info = await this.connection.getAccountInfo(positionPDA);
            if (!info) return null;

            const data = info.data.slice(8); // Skip discriminator

            const POSITION_MIN_SIZE = 105;
            if (data.length < POSITION_MIN_SIZE) {
                this.logger.error(`Position account data too short for ${owner} product ${productId}: ${data.length} < ${POSITION_MIN_SIZE}`);
                return null;
            }
            
            return {
                address: positionPDA.toString(),
                owner: new PublicKey(data.slice(0, 32)).toString(),
                productId: data.readUInt32LE(32),
                side: data[36] === 0 ? "long" : "short",
                size: Number(data.readBigUInt64LE(37)) / 1e6,
                entryPrice: Number(data.readBigUInt64LE(45)) / 1e8,
                leverage: data.readUInt32LE(53),
                margin: Number(data.readBigUInt64LE(57)) / 1e6,
                liquidationPrice: Number(data.readBigUInt64LE(65)) / 1e8,
                realizedPnl: Number(data.readBigInt64LE(73)) / 1e6,
                entryFundingRate: Number(data.readBigInt64LE(81)),
                openedAt: Number(data.readBigInt64LE(89)),
                lastUpdated: Number(data.readBigInt64LE(97)),
            };
        } catch (e) {
            this.logger.error(`Failed to fetch position for ${owner} product ${productId}:`, e);
            return null;
        }
    }

    // ── Oracle Prices (from keeper in-memory cache) ─────────────────────────

    async getOraclePrice(productId: number): Promise<OraclePrice | null> {
        const k = keeper();
        if (!k) return null;

        const cached = k.getCachedPrice(productId);
        if (!cached) return null;

        const updatedAt = Math.floor(cached.publishedAt / 1000);
        const now = Math.floor(Date.now() / 1000);

        return {
            productId,
            price: cached.priceUsd,
            updatedAt,
            ageSeconds: now - updatedAt,
        };
    }

    async getOraclePrices(productIds: number[]): Promise<Map<number, OraclePrice>> {
        return this.getOraclePricesBatch(productIds);
    }

    // ── Batch RPC Fetch ─────────────────────────────────────────────────────

    /**
     * Fetch multiple market accounts in a single RPC call using getMultipleAccountsInfo.
     * Much more efficient than individual getAccountInfo calls.
     */
    async getMarketsBatch(productIds: number[]): Promise<Map<number, MarketState>> {
        const results = new Map<number, MarketState>();
        if (productIds.length === 0) return results;

        // Solana limits getMultipleAccountsInfo to 100 accounts per call
        const BATCH_SIZE = 100;
        for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
            const batch = productIds.slice(i, i + BATCH_SIZE);
            const pdas = batch.map(id => getMarketPDA(id));

            try {
                const infos = await this.connection.getMultipleAccountsInfo(pdas);
                const MARKET_MIN_SIZE = 105;
                for (let j = 0; j < batch.length; j++) {
                    const info = infos[j];
                    if (!info) continue;

                    const data = info.data.slice(8);
                    if (data.length < MARKET_MIN_SIZE) continue;

                    results.set(batch[j]!, {
                        productId: data.readUInt32LE(0),
                        oraclePriceFeed: new PublicKey(data.slice(4, 36)).toString(),
                        maxLeverage: data.readUInt32LE(36),
                        maxOpenInterest: Number(data.readBigUInt64LE(40)) / 1e6,
                        longOpenInterest: Number(data.readBigUInt64LE(48)) / 1e6,
                        shortOpenInterest: Number(data.readBigUInt64LE(56)) / 1e6,
                        totalVolume: readU128AsVolumeString(data, 64),
                        lastFundingTime: Number(data.readBigInt64LE(80)),
                        cumulativeFundingRateLong: Number(data.readBigInt64LE(88)),
                        cumulativeFundingRateShort: Number(data.readBigInt64LE(96)),
                        active: data[104] === 1,
                    });
                }
            } catch (e) {
                this.logger.error(`Batch market fetch failed for chunk ${i}-${i + batch.length}:`, e);
            }
        }
        return results;
    }

    /**
     * Get oracle prices for multiple products from the keeper's in-memory cache.
     * No RPC calls needed — prices come from the TCGPlayer price cache.
     */
    async getOraclePricesBatch(productIds: number[]): Promise<Map<number, OraclePrice>> {
        const results = new Map<number, OraclePrice>();
        if (productIds.length === 0) return results;

        const k = keeper();
        if (!k) return results;

        const now = Math.floor(Date.now() / 1000);

        for (const productId of productIds) {
            const cached = k.getCachedPrice(productId);
            if (!cached) continue;

            const updatedAt = Math.floor(cached.publishedAt / 1000);

            results.set(productId, {
                productId,
                price: cached.priceUsd,
                updatedAt,
                ageSeconds: now - updatedAt,
            });
        }
        return results;
    }

    // ── Market Stats Cache ────────────────────────────────────────────────

    /**
     * Refresh the in-memory market stats cache for the given product IDs.
     * Uses batch RPC calls for efficiency.
     * Returns the number of markets successfully cached.
     */
    async refreshMarketStatsCache(productIds: number[]): Promise<{ updated: number; failed: number }> {
        if (productIds.length === 0) return { updated: 0, failed: 0 };

        // L-5: Prune stale entries that are no longer in the active product set
        const activeSet = new Set(productIds);
        for (const key of this._marketStatsCache.keys()) {
            if (!activeSet.has(key)) {
                this._marketStatsCache.delete(key);
            }
        }

        const t0 = Date.now();
        const [markets, oraclePrices] = await Promise.all([
            this.getMarketsBatch(productIds),
            this.getOraclePricesBatch(productIds),
        ]);

        let updated = 0;
        for (const productId of productIds) {
            const market = markets.get(productId);
            if (!market) continue;

            const oracle = oraclePrices.get(productId);
            const totalOI = market.longOpenInterest + market.shortOpenInterest;

            this._marketStatsCache.set(productId, {
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
            });
            updated++;
        }

        this._marketStatsCacheUpdatedAt = Date.now();
        const dur = Date.now() - t0;
        this.logger.info(`Market stats cache refreshed: ${updated} markets in ${dur}ms`);

        // Only count actual RPC errors as failures, not missing markets
        // (markets that don't exist on-chain simply return null from getMultipleAccountsInfo)
        return { updated, failed: 0 };
    }

    /**
     * Get all cached market stats.
     */
    getCachedMarketStats(): Map<number, MarketStatsEntry> {
        return this._marketStatsCache;
    }

    /**
     * Get cached market stats for a single product.
     */
    getCachedMarketStat(productId: number): MarketStatsEntry | undefined {
        return this._marketStatsCache.get(productId);
    }

    /**
     * Get the timestamp of the last cache update.
     */
    getMarketStatsCacheAge(): number {
        if (this._marketStatsCacheUpdatedAt === 0) return Infinity;
        return Date.now() - this._marketStatsCacheUpdatedAt;
    }

    /**
     * Get product IDs sorted by total volume (descending).
     * Only includes products that have on-chain markets.
     */
    getProductIdsSortedByVolume(): number[] {
        const entries = [...this._marketStatsCache.values()];
        entries.sort((a, b) => {
            const volA = parseFloat(a.totalVolume);
            const volB = parseFloat(b.totalVolume);
            return volB - volA;
        });
        return entries.map(e => e.productId);
    }

    // ── Transaction Builders ─────────────────────────────────────────────────
    // These return serialized unsigned transactions for frontend to sign

    /**
     * Build instruction data for creating a user account.
     * Returns the accounts and data needed for the frontend to construct the tx.
     */
    getCreateUserAccountParams(owner: string) {
        const ownerPubkey = new PublicKey(owner);
        const userAccountPDA = getUserAccountPDA(ownerPubkey);

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "createUserAccount",
            accounts: {
                userAccount: userAccountPDA.toString(),
                owner: owner,
                systemProgram: "11111111111111111111111111111111",
            },
        };
    }

    /**
     * Build params for closing a user account.
     * Account must have zero balance and no open positions.
     */
    getCloseUserAccountParams(owner: string) {
        const ownerPubkey = new PublicKey(owner);
        const userAccountPDA = getUserAccountPDA(ownerPubkey);

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "closeUserAccount",
            accounts: {
                userAccount: userAccountPDA.toString(),
                owner: owner,
            },
        };
    }

    /**
     * Build params for creating a market (permissionless).
     * Anyone can create a market, they pay the rent.
     */
    getCreateMarketParams(payer: string, productId: number) {
        const marketPDA = getMarketPDA(productId);
        const exchangePDA = getExchangePDA();

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "createMarketPermissionless",
            accounts: {
                market: marketPDA.toString(),
                exchangeState: exchangePDA.toString(),
                payer: payer,
                systemProgram: "11111111111111111111111111111111",
            },
            args: {
                productId,
            },
        };
    }

    /**
     * Build params for depositing USDC.
     */
    getDepositParams(owner: string, userTokenAccount: string, amount: number) {
        const ownerPubkey = new PublicKey(owner);
        const userAccountPDA = getUserAccountPDA(ownerPubkey);
        const exchangePDA = getExchangePDA();
        const vaultPDA = getVaultPDA();

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "deposit",
            accounts: {
                userAccount: userAccountPDA.toString(),
                exchangeState: exchangePDA.toString(),
                vault: vaultPDA.toString(),
                userTokenAccount: userTokenAccount,
                owner: owner,
                tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            },
            args: {
                amount: Math.floor(amount * 1e6), // Convert to USDC decimals
            },
        };
    }

    /**
     * Build params for withdrawing USDC.
     */
    getWithdrawParams(owner: string, userTokenAccount: string, amount: number) {
        const ownerPubkey = new PublicKey(owner);
        const userAccountPDA = getUserAccountPDA(ownerPubkey);
        const exchangePDA = getExchangePDA();
        const vaultPDA = getVaultPDA();

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "withdraw",
            accounts: {
                userAccount: userAccountPDA.toString(),
                exchangeState: exchangePDA.toString(),
                vault: vaultPDA.toString(),
                userTokenAccount: userTokenAccount,
                owner: owner,
                tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            },
            args: {
                amount: Math.floor(amount * 1e6),
            },
        };
    }

    /**
     * Build params for opening a position.
     * Oracle price is Ed25519-signed and verified via the Instructions sysvar.
     */
    getOpenPositionParams(
        owner: string,
        productId: number,
        side: "long" | "short",
        size: number,
        leverage: number,
    ) {
        const ownerPubkey = new PublicKey(owner);
        const userAccountPDA = getUserAccountPDA(ownerPubkey);
        const positionPDA = getPositionPDA(ownerPubkey, productId);
        const marketPDA = getMarketPDA(productId);
        const exchangePDA = getExchangePDA();
        const oracleStatePDA = getOracleStatePDA();

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "openPosition",
            accounts: {
                userAccount: userAccountPDA.toString(),
                position: positionPDA.toString(),
                market: marketPDA.toString(),
                exchangeState: exchangePDA.toString(),
                oracleState: oracleStatePDA.toString(),
                owner: owner,
                systemProgram: "11111111111111111111111111111111",
                instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            args: {
                productId,
                side: side === "long" ? 0 : 1,
                size: Math.floor(size * 1e6),
                leverage,
            },
        };
    }

    /**
     * Build params for closing a position.
     * Oracle price is Ed25519-signed and verified via the Instructions sysvar.
     */
    getClosePositionParams(
        owner: string,
        productId: number,
    ) {
        const ownerPubkey = new PublicKey(owner);
        const userAccountPDA = getUserAccountPDA(ownerPubkey);
        const positionPDA = getPositionPDA(ownerPubkey, productId);
        const marketPDA = getMarketPDA(productId);
        const exchangePDA = getExchangePDA();
        const vaultPDA = getVaultPDA();
        const insuranceFundPDA = getInsuranceFundPDA();
        const oracleStatePDA = getOracleStatePDA();

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "closePosition",
            accounts: {
                userAccount: userAccountPDA.toString(),
                position: positionPDA.toString(),
                market: marketPDA.toString(),
                exchangeState: exchangePDA.toString(),
                vault: vaultPDA.toString(),
                insuranceFund: insuranceFundPDA.toString(),
                oracleState: oracleStatePDA.toString(),
                owner: owner,
                tokenProgram: TOKEN_PROGRAM_ID,
                instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            args: {
                productId,
            },
        };
    }

    /**
     * Build params for adding margin to a position.
     */
    getAddMarginParams(
        owner: string,
        productId: number,
        amount: number
    ) {
        const ownerPubkey = new PublicKey(owner);
        const userAccountPDA = getUserAccountPDA(ownerPubkey);
        const positionPDA = getPositionPDA(ownerPubkey, productId);

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "addMargin",
            accounts: {
                userAccount: userAccountPDA.toString(),
                position: positionPDA.toString(),
                owner: owner,
            },
            args: {
                productId,
                amount: Math.floor(amount * 1e6),
            },
        };
    }

    /**
     * Build params for liquidating a position.
     * Oracle price is Ed25519-signed and verified via the Instructions sysvar.
     */
    getLiquidateParams(
        liquidator: string,
        positionOwner: string,
        productId: number,
    ) {
        const liquidatorPubkey = new PublicKey(liquidator);
        const positionOwnerPubkey = new PublicKey(positionOwner);
        const positionOwnerAccountPDA = getUserAccountPDA(positionOwnerPubkey);
        const positionPDA = getPositionPDA(positionOwnerPubkey, productId);
        const liquidatorAccountPDA = getUserAccountPDA(liquidatorPubkey);
        const marketPDA = getMarketPDA(productId);
        const exchangePDA = getExchangePDA();
        const vaultPDA = getVaultPDA();
        const insuranceFundPDA = getInsuranceFundPDA();
        const oracleStatePDA = getOracleStatePDA();

        return {
            programId: PROGRAM_ID().toString(),
            instruction: "liquidate",
            accounts: {
                positionOwnerAccount: positionOwnerAccountPDA.toString(),
                position: positionPDA.toString(),
                liquidatorAccount: liquidatorAccountPDA.toString(),
                market: marketPDA.toString(),
                exchangeState: exchangePDA.toString(),
                vault: vaultPDA.toString(),
                insuranceFund: insuranceFundPDA.toString(),
                oracleState: getOracleStatePDA().toString(),
                positionOwner: positionOwner,
                liquidator: liquidator,
                tokenProgram: TOKEN_PROGRAM_ID,
                instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            args: {
                productId,
            },
        };
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    getProgramId(): string {
        return PROGRAM_ID().toString();
    }

    getUsdcMint(): string {
        return USDC_MINT().toString();
    }

    getRpcUrl(): string {
        return env().solana.rpcUrl;
    }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _perpdex: PerpDexService | null = null;

export function perpdex(): PerpDexService {
    if (!_perpdex) {
        _perpdex = new PerpDexService();
    }
    return _perpdex;
}

export async function initPerpdex(): Promise<PerpDexService> {
    const svc = perpdex();
    await svc.init();
    return svc;
}
