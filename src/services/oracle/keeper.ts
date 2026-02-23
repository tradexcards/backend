/**
 * OracleKeeper — manages on-chain markets and caches live prices.
 *
 * With the Ed25519-signed oracle architecture, the keeper no longer pushes
 * prices on-chain. Instead it:
 *   1. Loads keypair for admin operations (create markets, withdraw fees)
 *   2. Initializes oracle state if needed (once)
 *   3. Creates Market PDAs for new products (base layer)
 *   4. Caches live TCGPlayer prices in memory for the oracle signer to read
 *
 * The oracle signer (signer.ts) reads from the price cache and signs prices
 * with Ed25519 when users request trades. Users include the Ed25519SigVerify
 * precompile instruction in their transaction — zero SOL cost for the oracle.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    SystemProgram,
} from "@solana/web3.js";
import { env, readActiveProductIds } from "../../env";
import { log as makeLog } from "../../log";
import { PriceOracle } from "./signer";

const L = makeLog("keeper");

// ── Types ───────────────────────────────────────────────────────────────────

export interface KeeperStats {
    totalUpdates: number;
    successfulUpdates: number;
    failedUpdates: number;
    totalTransactions: number;
    lastCycleAt: string | null;
    lastCycleDurationMs: number | null;
    marketsCreated: number;
    baseEndpoint: string;
    authority: string;
}

interface CachedPrice {
    priceScaled: number; // scaled u64 (from TCGPlayer cache)
    cachedAt: number;    // unix ms
}

// ── Constants ───────────────────────────────────────────────────────────────

const ORACLE_SEED = Buffer.from("oracle");
const MARKET_SEED = Buffer.from("market");
const EXCHANGE_SEED = Buffer.from("exchange");
const VAULT_SEED = Buffer.from("vault");

const PRICE_DECIMALS = 8;
const PRICE_SCALE = 10 ** PRICE_DECIMALS;

// Treasury wallet for fee withdrawals (hardcoded in program: Cv1x1DF9KKdNHSPYwCgcAipo3sYKcW4CpC3rRodwDABF)
const TREASURY_WALLET = new PublicKey("Cv1x1DF9KKdNHSPYwCgcAipo3sYKcW4CpC3rRodwDABF");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ── Anchor-compatible 8-byte instruction discriminators ─────────────────────
// sha256("global:<snake_case_name>")[..8]

const DISC = {
    initializeOracle:    Buffer.from([144, 223, 131, 120, 196, 253, 181, 99]),
    createMarket:        Buffer.from([103, 226, 97, 235, 200, 188, 251, 254]),
    withdrawFees:        Buffer.from([0xc6, 0xd4, 0xab, 0x6d, 0x90, 0xd7, 0xae, 0x59]),
    liquidateKeeper:     Buffer.from([0xc5, 0x66, 0x9e, 0x95, 0xca, 0xd8, 0x49, 0x36]),
    updateFundingRate:   Buffer.from([0xc9, 0xb2, 0x74, 0xd4, 0xa6, 0x90, 0x48, 0xee]),
} as const;

// Position discriminator for getProgramAccounts filter
const POSITION_DISC = Buffer.from([0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x17, 0x2b, 0x6c]);
const POSITION_DISC_BS58 = "VZMoMoKSX7H";

// On-chain constants (must match program/src/constants.rs)
const MAINTENANCE_MARGIN_BPS = 100n; // 1%
const BPS_DENOMINATOR = 10000n;

const USER_ACCOUNT_SEED = Buffer.from("user_account");
const POSITION_SEED = Buffer.from("position");
const INSURANCE_SEED = Buffer.from("insurance");

const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// ── Raw instruction builders ────────────────────────────────────────────────

/** Write a u32 little-endian into a Buffer at offset, return new offset. */
function writeU32LE(buf: Buffer, value: number, offset: number): number {
    buf.writeUInt32LE(value, offset);
    return offset + 4;
}

/** Write a u64 little-endian (as number) into a Buffer at offset, return new offset. */
function writeU64LE(buf: Buffer, value: number | bigint, offset: number): number {
    buf.writeBigUInt64LE(BigInt(value), offset);
    return offset + 8;
}

/**
 * Build initialize_oracle instruction.
 * On-chain accounts: [oracle_state (init PDA), authority (signer_mut), system_program]
 */
function buildInitializeOracleIx(programId: PublicKey, authority: PublicKey): TransactionInstruction {
    const oracleState = oracleStatePDA(programId);

    return new TransactionInstruction({
        programId,
        keys: [
            { pubkey: oracleState, isSigner: false, isWritable: true },
            { pubkey: authority, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: DISC.initializeOracle,
    });
}

/**
 * Build create_market instruction.
 * On-chain accounts: [market (init PDA), exchange_state (PDA mut), admin (signer_mut), system_program]
 */
function buildCreateMarketIx(
    programId: PublicKey,
    admin: PublicKey,
    productId: number,
    maxLeverage: number,
    maxOpenInterest: number | bigint,
): TransactionInstruction {
    const market = marketPDA(programId, productId);
    const exchangeState = exchangeStatePDA(programId);

    // discriminator (8) + product_id (4) + max_leverage (4) + max_open_interest (8) = 24
    const data = Buffer.alloc(24);
    DISC.createMarket.copy(data, 0);
    let off = writeU32LE(data, productId, 8);
    off = writeU32LE(data, maxLeverage, off);
    writeU64LE(data, maxOpenInterest, off);

    return new TransactionInstruction({
        programId,
        keys: [
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: exchangeState, isSigner: false, isWritable: true },
            { pubkey: admin, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}

function buildWithdrawFeesIx(
    programId: PublicKey,
    admin: PublicKey,
    vault: PublicKey,
    treasuryTokenAccount: PublicKey,
    amount: bigint,
): TransactionInstruction {
    const exchangeState = exchangeStatePDA(programId);

    // discriminator (8) + amount (8) = 16
    const data = Buffer.alloc(16);
    DISC.withdrawFees.copy(data, 0);
    writeU64LE(data, amount, 8);

    // Account order: exchange_state, vault, treasury_token_account, admin, token_program
    return new TransactionInstruction({
        programId,
        keys: [
            { pubkey: exchangeState, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
            { pubkey: admin, isSigner: true, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
    });
}

/**
 * Build the Ed25519SigVerify precompile instruction (same layout as frontend).
 * Layout: [num_sigs:1][padding:1][offsets:14][pubkey:32][signature:64][message:N]
 */
function buildEd25519Instruction(
    publicKey: Uint8Array,  // 32 bytes
    signature: Uint8Array,  // 64 bytes
    message: Uint8Array,    // N bytes
): TransactionInstruction {
    const msgLen = message.length;
    const dataLen = 2 + 14 + 32 + 64 + msgLen; // 112 + msgLen
    const data = new Uint8Array(dataLen);
    const view = new DataView(data.buffer);

    let off = 0;
    data[off++] = 1;   // num_sigs
    data[off++] = 0;   // padding

    const signatureOffset = 48;   // 2 + 14 + 32
    const publicKeyOffset = 16;   // 2 + 14
    const messageOffset = 112;    // 2 + 14 + 32 + 64

    view.setUint16(off, signatureOffset, true); off += 2;
    view.setUint16(off, 0xFFFF, true); off += 2;
    view.setUint16(off, publicKeyOffset, true); off += 2;
    view.setUint16(off, 0xFFFF, true); off += 2;
    view.setUint16(off, messageOffset, true); off += 2;
    view.setUint16(off, msgLen, true); off += 2;
    view.setUint16(off, 0xFFFF, true); off += 2;

    data.set(publicKey, off); off += 32;
    data.set(signature, off); off += 64;
    data.set(message, off);

    return new TransactionInstruction({
        programId: ED25519_PROGRAM_ID,
        keys: [],
        data: Buffer.from(data),
    });
}

/**
 * Build liquidate_keeper instruction.
 * On-chain accounts (11): position_owner_account, position, market, exchange_state,
 *   vault, insurance_fund, oracle_state, position_owner, keeper, token_program, instructions_sysvar
 * Data: [disc:8][product_id:4][price:8][timestamp:8] = 28 bytes
 */
function buildLiquidateKeeperIx(
    programId: PublicKey,
    positionOwnerAccount: PublicKey,  // UserAccount PDA of position owner
    position: PublicKey,              // Position PDA
    market: PublicKey,                // Market PDA
    exchangeState: PublicKey,         // Exchange PDA
    vault: PublicKey,                 // Vault token account
    insuranceFund: PublicKey,         // Insurance token account
    oracleState: PublicKey,           // Oracle PDA
    positionOwner: PublicKey,         // Raw pubkey of position owner
    keeper: PublicKey,                // Keeper signer
    productId: number,
    price: bigint,
    timestamp: number,
): TransactionInstruction {
    // disc(8) + product_id(4) + price(8) + timestamp(8) = 28 bytes
    const data = Buffer.alloc(28);
    DISC.liquidateKeeper.copy(data, 0);
    data.writeUInt32LE(productId, 8);
    data.writeBigUInt64LE(price, 12);
    data.writeBigInt64LE(BigInt(timestamp), 20);

    return new TransactionInstruction({
        programId,
        keys: [
            { pubkey: positionOwnerAccount, isSigner: false, isWritable: true },
            { pubkey: position, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: exchangeState, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: insuranceFund, isSigner: false, isWritable: true },
            { pubkey: oracleState, isSigner: false, isWritable: false },
            { pubkey: positionOwner, isSigner: false, isWritable: true },
            { pubkey: keeper, isSigner: true, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
        ],
        data,
    });
}

/**
 * Build update_funding_rate instruction.
 * On-chain accounts: [market (account_mut), exchange_state (pda), cranker (signer)]
 * Data: [disc:8][product_id:4] = 12 bytes
 */
function buildUpdateFundingRateIx(
    programId: PublicKey,
    cranker: PublicKey,
    productId: number,
): TransactionInstruction {
    const market = marketPDA(programId, productId);
    const exchangeState = exchangeStatePDA(programId);

    const data = Buffer.alloc(12);
    DISC.updateFundingRate.copy(data, 0);
    writeU32LE(data, productId, 8);

    return new TransactionInstruction({
        programId,
        keys: [
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: exchangeState, isSigner: false, isWritable: false },
            { pubkey: cranker, isSigner: true, isWritable: false },
        ],
        data,
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function oracleStatePDA(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [ORACLE_SEED],
        programId,
    );
    return pda;
}

function marketPDA(programId: PublicKey, productId: number): PublicKey {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(productId, 0);
    const [pda] = PublicKey.findProgramAddressSync(
        [MARKET_SEED, buf],
        programId,
    );
    return pda;
}

function exchangeStatePDA(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [EXCHANGE_SEED],
        programId,
    );
    return pda;
}

function vaultPDA(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [VAULT_SEED],
        programId,
    );
    return pda;
}

function userAccountPDA(programId: PublicKey, owner: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [USER_ACCOUNT_SEED, owner.toBuffer()],
        programId,
    );
    return pda;
}

function positionPDA(programId: PublicKey, owner: PublicKey, productId: number): PublicKey {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(productId, 0);
    const [pda] = PublicKey.findProgramAddressSync(
        [POSITION_SEED, owner.toBuffer(), buf],
        programId,
    );
    return pda;
}

function insuranceFundPDA(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [INSURANCE_SEED],
        programId,
    );
    return pda;
}

/** Derive the Associated Token Account address for a wallet + mint. */
function getAssociatedTokenAddress(wallet: PublicKey, mint: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
        [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    return ata;
}

function scalePrice(priceUsd: number): number {
    return Math.round(priceUsd * PRICE_SCALE);
}

function loadKeypair(path: string): Keypair {
    const resolved = path.startsWith("/") ? path : resolve(env().paths.root, path);
    if (!existsSync(resolved)) {
        throw new Error(`Keeper keypair not found: ${resolved}`);
    }
    const raw = JSON.parse(readFileSync(resolved, "utf-8"));
    return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Poll-based transaction confirmation. Avoids WebSocket entirely.
 * Polls getSignatureStatuses every 2s for up to `timeoutMs`.
 */
async function confirmTxPolling(
    connection: Connection,
    signature: string,
    timeoutMs = 60_000,
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { value } = await connection.getSignatureStatuses([signature]);
        const status = value?.[0];
        if (status) {
            if (status.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
            }
            if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
                return;
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
}

// ── State cache (SQLite) ─────────────────────────────────────────────────────

import { db } from "../db";

function saveKeeperState(programId: PublicKey, oracleInitialized: boolean): void {
    try {
        db().cacheSet("keeper", "program_id", programId.toBase58(), 365 * 86400);
        db().cacheSet("keeper", "oracle_initialized", oracleInitialized, 365 * 86400);
    } catch (e) {
        L.error("Failed to write keeper state:", e instanceof Error ? e.message : e);
    }
}

// ── On-chain math (must match program/src/helpers.rs) ───────────────────────

const PRICE_SCALE_BIGINT = BigInt(PRICE_SCALE);

/**
 * Replicate on-chain calculate_pnl exactly.
 * pnl = size * price_diff * PRICE_SCALE / entry_price / PRICE_SCALE
 * (the double-scale trick avoids truncation for small positions on expensive cards)
 */
function calculatePnl(entryPrice: bigint, currentPrice: bigint, size: bigint, side: number): bigint {
    const priceDiff = side === 0
        ? currentPrice - entryPrice   // Long: current - entry
        : entryPrice - currentPrice;  // Short: entry - current
    return (size * priceDiff * PRICE_SCALE_BIGINT) / entryPrice / PRICE_SCALE_BIGINT;
}

/** Replicate on-chain calculate_funding_payment. */
function calculateFundingPayment(entryFundingRate: bigint, currentCumulativeRate: bigint, size: bigint): bigint {
    const rateDiff = currentCumulativeRate - entryFundingRate;
    return (size * rateDiff) / BigInt(BPS_DENOMINATOR);
}

// ── Priority fee constants ──────────────────────────────────────────────────

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");

/** Build SetComputeUnitLimit instruction */
function buildSetComputeUnitLimitIx(units: number): TransactionInstruction {
    const data = Buffer.alloc(5);
    data.writeUInt8(2, 0); // instruction index for SetComputeUnitLimit
    data.writeUInt32LE(units, 1);
    return new TransactionInstruction({
        programId: COMPUTE_BUDGET_PROGRAM_ID,
        keys: [],
        data,
    });
}

/** Build SetComputeUnitPrice instruction (priority fee in micro-lamports) */
function buildSetComputeUnitPriceIx(microLamports: bigint): TransactionInstruction {
    const data = Buffer.alloc(9);
    data.writeUInt8(3, 0); // instruction index for SetComputeUnitPrice
    data.writeBigUInt64LE(microLamports, 1);
    return new TransactionInstruction({
        programId: COMPUTE_BUDGET_PROGRAM_ID,
        keys: [],
        data,
    });
}

// ── Liquidation max staleness ───────────────────────────────────────────────

/** Max age of a cached price (in ms) before we refuse to use it for liquidation.
 *  Must be under the on-chain MAX_ORACLE_PRICE_AGE (15s) since we sign at send time.
 *  Using 10s to leave headroom for network latency + slot confirmation. */
const LIQUIDATION_MAX_PRICE_AGE_MS = 10_000; // 10 seconds

/** Priority fee for liquidation transactions (micro-lamports per CU) */
const LIQUIDATION_PRIORITY_FEE = 50_000n; // 50k µL/CU ≈ reasonable priority

/** Compute units for liquidation (Ed25519 verify + program logic) */
const LIQUIDATION_COMPUTE_UNITS = 200_000;

/** Max concurrent liquidation sends */
const LIQUIDATION_BATCH_SIZE = 5;

// ── OracleKeeper ────────────────────────────────────────────────────────────

export class OracleKeeper {
    private keypair!: Keypair;
    private programId!: PublicKey;
    private oracleState!: PublicKey;
    private oracleSigner!: PriceOracle;

    // Base layer connection (only connection needed — no ER)
    private baseConnection!: Connection;
    private fallbackConnection: Connection | null = null;

    // Cached exchange state addresses (static — set once at init)
    private cachedVaultAddress: PublicKey | null = null;
    private cachedInsuranceFundAddress: PublicKey | null = null;

    // Set of product IDs that have confirmed on-chain markets.
    // Populated by ensureMarkets() at boot and createMarket() on-demand.
    // Used by crankFundingRates() to avoid sending txs for non-existent markets.
    private onchainMarketProductIds = new Set<number>();

    // In-flight liquidation tracking (prevents duplicate submissions)
    // Map of "owner:productId" → timestamp (ms) when submitted
    private inFlightLiquidations = new Map<string, number>();

    // State
    private priceCache = new Map<number, CachedPrice>();
    private oracleStateConfirmed = false;
    private initialized = false;
    private running = false;
    private balanceTimer: ReturnType<typeof setInterval> | null = null;

    // Stats
    private stats: KeeperStats = {
        totalUpdates: 0,
        successfulUpdates: 0,
        failedUpdates: 0,
        totalTransactions: 0,
        lastCycleAt: null,
        lastCycleDurationMs: null,
        marketsCreated: 0,
        baseEndpoint: "",
        authority: "",
    };

    // ── Initialization ──────────────────────────────────────────────────────

    async init(): Promise<void> {
        if (this.initialized) return;

        const cfg = env();

        // Load keypair
        this.keypair = loadKeypair(cfg.keeper.keypairPath);
        L.info(`Authority: ${this.keypair.publicKey.toBase58()}`);

        // Program ID from env
        this.programId = new PublicKey(cfg.program.programId);
        this.oracleState = oracleStatePDA(this.programId);
        L.info(`Program ID: ${this.programId.toBase58()}`);
        L.info(`Oracle State PDA: ${this.oracleState.toBase58()}`);

        // Base layer connection (HTTP-only — WSS can be unreliable)
        this.baseConnection = new Connection(cfg.solana.rpcUrl, { commitment: "confirmed" });

        // Fallback connection for resilience
        if (cfg.solana.rpcFallbackUrl) {
            this.fallbackConnection = new Connection(cfg.solana.rpcFallbackUrl, { commitment: "confirmed" });
            L.info(`Fallback RPC: ${cfg.solana.rpcFallbackUrl.replace(/api-key=.*/, "api-key=***")}`);
        }

        // Suppress WebSocket errors
        try {
            const ws = (this.baseConnection as any)._rpcWebSocket;
            if (ws) {
                ws.on("error", () => {/* swallowed */});
            }
        } catch { /* ignore */ }

        // Initialize Ed25519 oracle signer for liquidation transactions
        this.oracleSigner = new PriceOracle(this.keypair);

        this.stats.baseEndpoint = cfg.solana.rpcUrl;
        this.stats.authority = this.keypair.publicKey.toBase58();

        // Check balance (warning only - keeper can still sign prices without SOL)
        const balance = await this.baseConnection.getBalance(this.keypair.publicKey);
        L.info(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

        if (balance < 0.01 * 1e9) {
            L.warn("Keeper wallet has low balance (< 0.01 SOL) - on-chain operations will fail but price signing still works");
        }

        // Restore cached oracle init state from SQLite
        const storedProgramId = db().cacheGetRaw<string>("keeper", "program_id");
        if (storedProgramId === this.programId.toBase58()) {
            const oracleInit = db().cacheGetRaw<boolean>("keeper", "oracle_initialized");
            this.oracleStateConfirmed = oracleInit === true;
            if (this.oracleStateConfirmed) {
                L.info("Restored oracle init state from SQLite (oracle_init=true)");
            }
        }

        this.initialized = true;
        L.info("Initialized");
    }

    // ── RPC connection helper ────────────────────────────────────────────────

    /** Cached active connection — switches to fallback if primary is down. */
    private activeConnection: Connection | null = null;

    /** Get a working connection — tries primary, falls back to secondary.
     *  Caches the result so subsequent calls don't re-test. */
    private async getConnection(): Promise<Connection> {
        if (this.activeConnection) return this.activeConnection;
        try {
            await this.baseConnection.getSlot();
            this.activeConnection = this.baseConnection;
            return this.baseConnection;
        } catch {
            if (this.fallbackConnection) {
                L.warn("Primary RPC failed, using fallback");
                this.activeConnection = this.fallbackConnection;
                return this.fallbackConnection;
            }
            throw new Error("All RPC endpoints unreachable");
        }
    }

    /** Reset cached connection — forces re-evaluation on next getConnection() call.
     *  Called at the start of each scan cycle so we detect recovered primary. */
    private resetConnectionCache(): void {
        this.activeConnection = null;
    }

    // ── Base layer tx helper ─────────────────────────────────────────────────

    private async sendBaseTransaction(tx: Transaction): Promise<string> {
        const conn = await this.getConnection();
        tx.feePayer = this.keypair.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.sign(this.keypair);
        const txHash = await conn.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 2,
        });
        await confirmTxPolling(this.baseConnection, txHash);
        return txHash;
    }

    /** Ensure oracle state account exists. Creates if needed (idempotent). */
    async ensureOracleState(): Promise<void> {
        if (this.oracleStateConfirmed) {
            L.info("Oracle state already initialized (cached)");
            return;
        }

        const info = await this.baseConnection.getAccountInfo(this.oracleState);
        if (info) {
            L.info("Oracle state already initialized");
        } else {
            L.info("Initializing oracle state...");
            const ix = buildInitializeOracleIx(this.programId, this.keypair.publicKey);
            const tx = new Transaction().add(ix);
            const txHash = await this.sendBaseTransaction(tx);
            L.info(`Oracle state initialized: ${txHash}`);
        }
        this.oracleStateConfirmed = true;
        this.persistState();
    }

    private persistState(): void {
        saveKeeperState(this.programId, this.oracleStateConfirmed);
    }

    // ── Market management ──────────────────────────────────────────────────

    async ensureMarkets(productIds: number[]): Promise<{ created: number; existing: number; errors: number }> {
        let created = 0;
        let existing = 0;
        let errors = 0;

        const MAX_LEVERAGE = 50;
        const MAX_OI = 1_000_000_000_000; // $1M in USDC units (6 decimals)

        for (let idx = 0; idx < productIds.length; idx++) {
            const pid = productIds[idx];
            const progress = `[${idx + 1}/${productIds.length}]`;
            const mPDA = marketPDA(this.programId, pid);

            try {
                const info = await this.baseConnection.getAccountInfo(mPDA);
                if (info) {
                    existing++;
                    this.onchainMarketProductIds.add(pid);
                    continue;
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                L.error(`${progress} Failed to check market ${pid}: ${msg}`);
                errors++;
                continue;
            }

            try {
                L.info(`${progress} Creating market for product ${pid}...`);
                const ix = buildCreateMarketIx(
                    this.programId, this.keypair.publicKey,
                    pid, MAX_LEVERAGE, MAX_OI,
                );
                const txHash = await this.sendBaseTransaction(new Transaction().add(ix));
                created++;
                this.stats.marketsCreated++;
                this.onchainMarketProductIds.add(pid);
                L.info(`${progress} Created market ${pid}: ${txHash}`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes("already in use") || msg.includes("0x0")) {
                    existing++;
                    this.onchainMarketProductIds.add(pid);
                } else {
                    L.error(`${progress} Failed to create market ${pid}: ${msg}`);
                    errors++;
                }
            }
        }

        L.info(`Markets: ${created} created, ${existing} existing, ${errors} errors`);
        return { created, existing, errors };
    }

    /**
     * On-demand creation: create a market for a single product.
     */
    async createMarket(productId: number): Promise<{ success: boolean; error?: string }> {
        if (!this.initialized) {
            return { success: false, error: "Keeper not initialized" };
        }

        L.info(`On-demand market creation for product ${productId}...`);

        const marketResult = await this.ensureMarkets([productId]);
        if (marketResult.errors > 0 && marketResult.created === 0 && marketResult.existing === 0) {
            return { success: false, error: `Failed to create market for product ${productId}` };
        }

        L.info(`On-demand creation complete for product ${productId}: market=${marketResult.created ? 'new' : 'existed'}`);
        return { success: true };
    }

    private getActiveProductIds(): number[] {
        return readActiveProductIds(env().keeper.cycleBatchSize);
    }

    // ── Price caching ───────────────────────────────────────────────────────

    /**
     * Run one price update cycle:
     *   1. Read latest cached prices from TCGPlayer
     *   2. Update in-memory price cache for oracle signer to read
     *
     * Prices are cached in memory and signed on-demand by the oracle signer
     * when users request trades. No on-chain publishing.
     */
    async runUpdateCycle(): Promise<{ updated: number; failed: number }> {
        if (!this.initialized) return { updated: 0, failed: 0 };

        const t0 = Date.now();
        const cfg = env();
        const { tcgplayer } = await import("../tcgplayer");
        const client = tcgplayer();

        const activeIds = this.getActiveProductIds();

        let updated = 0;
        const now = Date.now();

        for (const pid of activeIds) {
            const pricing = await client.getCachedPricingRaw(pid);
            if (!pricing) continue;

            // Skip stale prices
            if (pricing.fetched_at) {
                const ageMs = Date.now() - new Date(pricing.fetched_at).getTime();
                if (ageMs > cfg.program.maxPriceAgeSeconds * 1000) continue;
            }

            const price = pricing.market_price || pricing.lowest_price || 0;
            if (!Number.isFinite(price) || price <= 0) continue;

            const scaled = scalePrice(price);
            if (scaled <= 0 || !Number.isSafeInteger(scaled)) continue;

            this.priceCache.set(pid, { priceScaled: scaled, cachedAt: now });
            updated++;
        }

        this.stats.totalUpdates += updated;
        this.stats.successfulUpdates += updated;
        this.stats.lastCycleAt = new Date().toISOString();
        this.stats.lastCycleDurationMs = Date.now() - t0;

        L.info(`Cached ${updated} prices in ${Date.now() - t0}ms`);

        return { updated, failed: 0 };
    }

    // ── Funding Rate Cranking ──────────────────────────────────────────────

    /**
     * Crank update_funding_rate for markets that exist on-chain.
     * Called before liquidation scans to ensure funding rates are fresh.
     * Only iterates products in onchainMarketProductIds (populated by ensureMarkets
     * at boot and createMarket on-demand) to avoid wasting RPC calls on
     * non-existent markets.
     * Ignores FundingTooEarly errors (expected when interval hasn't elapsed).
     */
    private async crankFundingRates(): Promise<void> {
        const marketIds = [...this.onchainMarketProductIds];
        if (marketIds.length === 0) return;

        // Batch multiple update_funding_rate instructions per transaction to
        // minimize RPC calls. Each instruction is small (~47 bytes unique data),
        // so we can safely fit 10 per tx within the 1232-byte limit.
        const BATCH_SIZE = 10;
        const conn = await this.getConnection();
        const { blockhash } = await conn.getLatestBlockhash();

        for (let i = 0; i < marketIds.length; i += BATCH_SIZE) {
            const batch = marketIds.slice(i, i + BATCH_SIZE);
            const tx = new Transaction();
            for (const pid of batch) {
                tx.add(buildUpdateFundingRateIx(
                    this.programId,
                    this.keypair.publicKey,
                    pid,
                ));
            }
            tx.feePayer = this.keypair.publicKey;
            tx.recentBlockhash = blockhash;
            tx.sign(this.keypair);

            try {
                await conn.sendRawTransaction(tx.serialize(), {
                    skipPreflight: false,
                    maxRetries: 1,
                });
                // Fire-and-forget — we don't need to wait for confirmation
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                // Expected errors — skip silently
                if (
                    msg.includes("FundingTooEarly") || msg.includes("0x1787") ||
                    msg.includes("MarketInactive") || msg.includes("0x1782") ||
                    msg.includes("owner is not allowed") || msg.includes("AccountNotInitialized")
                ) {
                    // Normal — entire batch skipped (all markets likely too early)
                } else {
                    const pids = batch.join(",");
                    L.warn(`Failed to crank funding batch [${pids}]: ${msg}`);
                }
            }
        }
    }

    // ── Liquidation ────────────────────────────────────────────────────────

    /**
     * Ensure vault and insurance fund addresses are cached.
     * These are derived from exchange state and never change.
     */
    private async ensureExchangeAddresses(): Promise<{ vault: PublicKey; insuranceFund: PublicKey } | null> {
        if (this.cachedVaultAddress && this.cachedInsuranceFundAddress) {
            return { vault: this.cachedVaultAddress, insuranceFund: this.cachedInsuranceFundAddress };
        }

        try {
            const exchangePDA = exchangeStatePDA(this.programId);
            const conn = await this.getConnection();
            const exchangeInfo = await conn.getAccountInfo(exchangePDA);
            if (!exchangeInfo) {
                L.error("Exchange state not found");
                return null;
            }
            const exData = exchangeInfo.data.slice(8); // skip discriminator
            this.cachedVaultAddress = new PublicKey(exData.slice(96, 128));
            this.cachedInsuranceFundAddress = new PublicKey(exData.slice(128, 160));
            L.info(`Cached exchange addresses: vault=${this.cachedVaultAddress.toBase58().slice(0, 8)}... insurance=${this.cachedInsuranceFundAddress.toBase58().slice(0, 8)}...`);
            return { vault: this.cachedVaultAddress, insuranceFund: this.cachedInsuranceFundAddress };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            L.error(`Failed to fetch exchange state: ${msg}`);
            return null;
        }
    }

    /**
     * Scan all open positions and liquidate those that are underwater.
     *
     * Uses the exact same math as the on-chain program:
     *   effective_margin = margin + pnl - funding_payment
     *   liquidatable if effective_margin < maintenance_margin (1% of size)
     *
     * Production safeguards:
     *   - Staleness guard: skips positions if cached price is >60s old
     *   - Proper math: computes PnL + funding, not just liquidation_price comparison
     *   - Deduplication: tracks in-flight liquidations to avoid duplicate submissions
     *   - Priority fees: includes ComputeBudget instructions for reliable landing
     *   - Batch sends: reuses blockhash, sends up to 5 liquidations in parallel
     *   - Error parsing: checks sendRawTransaction errors without waiting for timeout
     */
    async scanAndLiquidate(): Promise<{ scanned: number; liquidated: number; errors: number }> {
        if (!this.initialized) return { scanned: 0, liquidated: 0, errors: 0 };

        const t0 = Date.now();
        let scanned = 0;
        let liquidated = 0;
        let errors = 0;

        // Reset connection cache so we re-evaluate primary vs fallback each cycle
        this.resetConnectionCache();

        // Sweep stale in-flight entries (older than 2 minutes = confirmation timeout + buffer)
        const INFLIGHT_STALE_MS = 120_000;
        const now = Date.now();
        for (const [key, timestamp] of this.inFlightLiquidations) {
            if (now - timestamp > INFLIGHT_STALE_MS) {
                this.inFlightLiquidations.delete(key);
            }
        }

        // Step 0a: Crank funding rates to ensure they're fresh before checking liquidations
        try {
            await this.crankFundingRates();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            L.warn(`Funding rate crank failed (continuing with scan): ${msg}`);
        }

        // Step 0b: Ensure exchange addresses are cached (#8)
        const exchangeAddrs = await this.ensureExchangeAddresses();
        if (!exchangeAddrs) return { scanned: 0, liquidated: 0, errors: 1 };
        const { vault: vaultAddress, insuranceFund: insuranceFundAddress } = exchangeAddrs;

        // Step 1: Fetch all Position accounts with dataSize filter (#3)
        // Position accounts are exactly 113 bytes (8 disc + 105 data)
        const conn = await this.getConnection();
        let positionAccounts: Array<{ pubkey: PublicKey; account: { data: Buffer } }>;
        try {
            positionAccounts = await conn.getProgramAccounts(this.programId, {
                filters: [
                    { dataSize: 113 }, // exact Position account size
                    { memcmp: { offset: 0, bytes: POSITION_DISC_BS58 } },
                ],
            }) as any;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            L.error(`Failed to fetch position accounts: ${msg}`);
            return { scanned: 0, liquidated: 0, errors: 1 };
        }

        if (positionAccounts.length === 0) {
            return { scanned: 0, liquidated: 0, errors: 0 };
        }

        // Step 1b: Fetch all market accounts to get cumulative funding rates (#1)
        // We need this for the proper liquidation check math
        const productIds = new Set<number>();
        for (const { account } of positionAccounts) {
            const data = Buffer.from(account.data);
            if (data.length < 8 + 105) continue;
            productIds.add(data.readUInt32LE(8 + 32)); // product_id at offset 32 after disc
        }

        const marketFundingRates = new Map<number, { long: bigint; short: bigint }>();
        if (productIds.size > 0) {
            const marketPDAs = [...productIds].map(pid => marketPDA(this.programId, pid));
            try {
                // Batch fetch in groups of 100 (Solana limit)
                for (let i = 0; i < marketPDAs.length; i += 100) {
                    const batch = marketPDAs.slice(i, i + 100);
                    const batchPids = [...productIds].slice(i, i + 100);
                    const infos = await conn.getMultipleAccountsInfo(batch);
                    for (let j = 0; j < infos.length; j++) {
                        const info = infos[j];
                        if (!info || info.data.length < 113) continue;
                        const mData = info.data.slice(8); // skip discriminator
                        const pid = mData.readUInt32LE(0);
                        const cumFundingLong = mData.readBigInt64LE(88);
                        const cumFundingShort = mData.readBigInt64LE(96);
                        marketFundingRates.set(pid, { long: cumFundingLong, short: cumFundingShort });
                    }
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                L.error(`Failed to fetch market funding rates: ${msg}`);
                // Continue — we'll skip positions for markets we can't get rates for
            }
        }

        L.info(`Scanning ${positionAccounts.length} positions (${productIds.size} markets) for liquidation...`);

        // Step 2: Check each position using proper on-chain math (#1)
        interface LiquidationCandidate {
            owner: PublicKey;
            productId: number;
            side: number;
            sizeRaw: bigint;
            marginRaw: bigint;
            currentPriceScaled: bigint;
            effectiveMargin: bigint;
            maintenanceMargin: bigint;
        }
        const candidates: LiquidationCandidate[] = [];

        for (const { account } of positionAccounts) {
            scanned++;

            const data = Buffer.from(account.data);
            if (data.length < 8 + 105) continue;

            const posData = data.slice(8); // skip discriminator

            // Parse all position fields needed for math
            const owner = new PublicKey(posData.slice(0, 32));
            const productId = posData.readUInt32LE(32);
            const side = posData[36]!; // 0 = long, 1 = short
            const sizeRaw = posData.readBigUInt64LE(37);
            const entryPriceRaw = posData.readBigUInt64LE(45);
            const marginRaw = posData.readBigUInt64LE(57);
            const entryFundingRate = posData.readBigInt64LE(81);

            if (sizeRaw === 0n) continue;

            // Staleness guard (#2): skip if cached price is too old
            const cached = this.priceCache.get(productId);
            if (!cached || cached.priceScaled <= 0) continue;
            const priceAgeMs = Date.now() - cached.cachedAt;
            if (priceAgeMs > LIQUIDATION_MAX_PRICE_AGE_MS) continue;

            // Skip if we don't have funding rates for this market
            const funding = marketFundingRates.get(productId);
            if (!funding) continue;

            const currentPriceScaled = BigInt(cached.priceScaled);

            // Replicate on-chain liquidation math exactly (#1)
            const pnl = calculatePnl(entryPriceRaw, currentPriceScaled, sizeRaw, side);
            const currentCumulativeRate = side === 0 ? funding.long : funding.short;
            const fundingPayment = calculateFundingPayment(entryFundingRate, currentCumulativeRate, sizeRaw);
            const netPnl = pnl - fundingPayment;

            const maintenanceMargin = (sizeRaw * MAINTENANCE_MARGIN_BPS) / BPS_DENOMINATOR;
            const effectiveMargin = BigInt(marginRaw) + netPnl; // margin is u64, netPnl is i64

            // Position is liquidatable when effective_margin < maintenance_margin
            if (effectiveMargin >= BigInt(maintenanceMargin)) continue;

            // Deduplication (#5): skip if already in-flight
            const liqKey = `${owner.toBase58()}:${productId}`;
            if (this.inFlightLiquidations.has(liqKey)) continue;

            candidates.push({
                owner,
                productId,
                side,
                sizeRaw,
                marginRaw,
                currentPriceScaled,
                effectiveMargin,
                maintenanceMargin: BigInt(maintenanceMargin),
            });
        }

        if (candidates.length === 0) {
            return { scanned, liquidated: 0, errors: 0 };
        }

        L.info(`Found ${candidates.length} liquidatable positions`);

        // Step 3: Build and send liquidation transactions in batches (#4)
        // Reuse a single blockhash for the batch
        let blockhash: string;
        try {
            blockhash = (await conn.getLatestBlockhash()).blockhash;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            L.error(`Failed to get blockhash: ${msg}`);
            return { scanned, liquidated: 0, errors: candidates.length };
        }

        // Process in batches of LIQUIDATION_BATCH_SIZE
        for (let i = 0; i < candidates.length; i += LIQUIDATION_BATCH_SIZE) {
            const batch = candidates.slice(i, i + LIQUIDATION_BATCH_SIZE);

            // Refresh blockhash between batches (except first)
            if (i > 0) {
                try {
                    blockhash = (await conn.getLatestBlockhash()).blockhash;
                } catch {
                    // Use previous blockhash — it may still be valid
                }
            }

            const sendPromises = batch.map(async (candidate) => {
                const liqKey = `${candidate.owner.toBase58()}:${candidate.productId}`;
                this.inFlightLiquidations.set(liqKey, Date.now());

                const sideStr = candidate.side === 0 ? "LONG" : "SHORT";
                const priceStr = (Number(candidate.currentPriceScaled) / 1e8).toFixed(4);
                const marginStr = (Number(candidate.effectiveMargin) / 1e6).toFixed(2);
                const maintStr = (Number(candidate.maintenanceMargin) / 1e6).toFixed(2);
                L.info(`Liquidating ${sideStr} product=${candidate.productId} owner=${candidate.owner.toBase58()} price=$${priceStr} eff_margin=$${marginStr} maint=$${maintStr}`);

                try {
                    // Sign the price with Ed25519
                    const signedPrice = this.oracleSigner.signPrice(
                        candidate.productId,
                        candidate.currentPriceScaled,
                    );

                    // Build instructions: ComputeBudget + Ed25519SigVerify + liquidate_keeper (#6)
                    const computeLimitIx = buildSetComputeUnitLimitIx(LIQUIDATION_COMPUTE_UNITS);
                    const priorityFeeIx = buildSetComputeUnitPriceIx(LIQUIDATION_PRIORITY_FEE);
                    const ed25519Ix = buildEd25519Instruction(
                        signedPrice.publicKey,
                        signedPrice.signature,
                        signedPrice.message,
                    );

                    const ownerAccountPDA = userAccountPDA(this.programId, candidate.owner);
                    const positionPDAAddr = positionPDA(this.programId, candidate.owner, candidate.productId);
                    const marketPDAAddr = marketPDA(this.programId, candidate.productId);
                    const exchangePDA = exchangeStatePDA(this.programId);

                    const liquidateIx = buildLiquidateKeeperIx(
                        this.programId,
                        ownerAccountPDA,
                        positionPDAAddr,
                        marketPDAAddr,
                        exchangePDA,
                        vaultAddress,
                        insuranceFundAddress,
                        this.oracleState,
                        candidate.owner,
                        this.keypair.publicKey,
                        candidate.productId,
                        signedPrice.price,
                        signedPrice.timestamp,
                    );

                    // Build VersionedTransaction (V0)
                    const messageV0 = new TransactionMessage({
                        payerKey: this.keypair.publicKey,
                        recentBlockhash: blockhash,
                        instructions: [computeLimitIx, priorityFeeIx, ed25519Ix, liquidateIx],
                    }).compileToV0Message();

                    const vtx = new VersionedTransaction(messageV0);
                    vtx.sign([this.keypair]);

                    // Send with preflight disabled (we already validated off-chain) (#7)
                    const txHash = await conn.sendRawTransaction(vtx.serialize(), {
                        skipPreflight: false, // let RPC check for obvious errors
                        maxRetries: 2,
                    });

                    // Confirm asynchronously — don't block the batch (#4)
                    confirmTxPolling(conn, txHash, 30_000)
                        .then(() => {
                            L.info(`Confirmed liquidation: product=${candidate.productId} owner=${candidate.owner.toBase58()} tx=${txHash}`);
                        })
                        .catch((err) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            L.error(`Liquidation tx failed confirmation: product=${candidate.productId} owner=${candidate.owner.toBase58()} tx=${txHash}: ${msg}`);
                        })
                        .finally(() => {
                            this.inFlightLiquidations.delete(liqKey);
                        });

                    return { success: true, txHash };
                } catch (e) {
                    this.inFlightLiquidations.delete(liqKey);
                    const msg = e instanceof Error ? e.message : String(e);

                    // Parse known on-chain errors (#7)
                    if (msg.includes("PositionNotLiquidatable") || msg.includes("0x1778")) {
                        L.warn(`Position not liquidatable on-chain (race): product=${candidate.productId} owner=${candidate.owner.toBase58()}`);
                    } else if (msg.includes("OraclePriceStale") || msg.includes("0x1775")) {
                        L.warn(`Oracle price stale on-chain: product=${candidate.productId}`);
                    } else {
                        L.error(`Failed to liquidate product=${candidate.productId} owner=${candidate.owner.toBase58()}: ${msg}`);
                    }
                    return { success: false };
                }
            });

            const results = await Promise.allSettled(sendPromises);
            for (const r of results) {
                if (r.status === "fulfilled" && r.value.success) {
                    liquidated++;
                } else {
                    errors++;
                }
            }
        }

        const dur = Date.now() - t0;
        L.info(`Liquidation scan: ${scanned} scanned, ${candidates.length} candidates, ${liquidated} sent, ${errors} errors in ${dur}ms`);

        return { scanned, liquidated, errors };
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    start(): void {
        if (this.running) return;
        this.running = true;

        L.info(`Starting — price caching via pricing loop`);

        // Periodic SOL balance check (every 10 min)
        this.balanceTimer = setInterval(async () => {
            try {
                const balance = await this.baseConnection.getBalance(this.keypair.publicKey);
                const solBalance = balance / 1e9;
                if (solBalance < 0.01) {
                    L.error(`CRITICAL BALANCE: ${solBalance.toFixed(4)} SOL — keeper will fail to send transactions`);
                } else if (solBalance < 0.05) {
                    L.warn(`LOW BALANCE: ${solBalance.toFixed(4)} SOL — keeper may run out of funds soon`);
                }
            } catch (e) {
                L.error("Balance check error:", e instanceof Error ? e.message : e);
            }
        }, 10 * 60 * 1000);
    }

    stop(): void {
        if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null; }
        this.running = false;
        L.info("Stopped");
    }

    isRunning(): boolean { return this.running; }

    getPublicKey(): PublicKey {
        return this.keypair.publicKey;
    }

    /**
     * Verify a SOL payment was received from a specific sender.
     */
    async verifyPayment(signature: string, sender: string, minAmountLamports: number): Promise<boolean> {
        try {
            const tx = await this.baseConnection.getTransaction(signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            });
            if (!tx || !tx.meta) return false;
            if (tx.meta.err) return false;

            const accountKeys = tx.transaction.message.getAccountKeys();
            const keeperKey = this.keypair.publicKey.toBase58();
            const senderKey = sender;

            let keeperIndex = -1;
            let senderIndex = -1;
            for (let i = 0; i < accountKeys.length; i++) {
                const key = accountKeys.get(i)?.toBase58();
                if (key === keeperKey) keeperIndex = i;
                if (key === senderKey) senderIndex = i;
            }

            if (keeperIndex === -1 || senderIndex === -1) return false;

            const preBalances = tx.meta.preBalances;
            const postBalances = tx.meta.postBalances;
            
            const keeperReceived = postBalances[keeperIndex]! - preBalances[keeperIndex]!;
            const senderSent = preBalances[senderIndex]! - postBalances[senderIndex]!;

            return keeperReceived >= minAmountLamports && senderSent >= minAmountLamports;
        } catch (e) {
            L.error("Failed to verify payment:", e);
            return false;
        }
    }

    // ── Fee Withdrawal ──────────────────────────────────────────────────────

    async withdrawFees(amountNative: number): Promise<{ success: boolean; signature?: string; error?: string }> {
        if (!this.initialized) {
            return { success: false, error: "Keeper not initialized" };
        }

        if (amountNative <= 0) {
            return { success: false, error: "Amount must be positive" };
        }

        const cfg = env();
        const usdcMint = new PublicKey(cfg.program.usdcMint);
        const amountUsdc = amountNative / 1_000_000;

        const vault = vaultPDA(this.programId);
        const treasuryAta = getAssociatedTokenAddress(TREASURY_WALLET, usdcMint);

        L.info(`Withdrawing ${amountUsdc} USDC (${amountNative} native) to treasury (${TREASURY_WALLET.toBase58()})...`);

        try {
            const ataInfo = await this.baseConnection.getAccountInfo(treasuryAta);
            if (!ataInfo) {
                return { success: false, error: `Treasury ATA does not exist. Create it first: ${treasuryAta.toBase58()}` };
            }

            const ix = buildWithdrawFeesIx(
                this.programId,
                this.keypair.publicKey,
                vault,
                treasuryAta,
                BigInt(amountNative),
            );

            const signature = await this.sendBaseTransaction(new Transaction().add(ix));
            L.info(`Withdrew ${amountUsdc} USDC to treasury: ${signature}`);

            return { success: true, signature };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            L.error(`Failed to withdraw fees: ${msg}`);
            return { success: false, error: msg };
        }
    }

    getUsdcMint(): PublicKey {
        return new PublicKey(env().program.usdcMint);
    }

    getTreasuryWallet(): PublicKey {
        return TREASURY_WALLET;
    }

    getTreasuryAta(): PublicKey {
        return getAssociatedTokenAddress(TREASURY_WALLET, this.getUsdcMint());
    }

    getStats(): KeeperStats {
        return { ...this.stats };
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get the cached price for a product.
     * Returns the unscaled USD price from the TCGPlayer cache, or null if not available.
     */
    getCachedPrice(productId: number): { priceUsd: number; publishedAt: number } | null {
        const cached = this.priceCache.get(productId);
        if (!cached || cached.cachedAt === 0 || cached.priceScaled <= 0) return null;
        return {
            priceUsd: cached.priceScaled / PRICE_SCALE,
            publishedAt: cached.cachedAt,
        };
    }

    /**
     * Get all cached prices as a map: productId → { priceUsd, publishedAt }.
     */
    getAllCachedPrices(): Map<number, { priceUsd: number; publishedAt: number }> {
        const map = new Map<number, { priceUsd: number; publishedAt: number }>();
        for (const [pid, cached] of this.priceCache) {
            if (cached.cachedAt > 0 && cached.priceScaled > 0) {
                map.set(pid, {
                    priceUsd: cached.priceScaled / PRICE_SCALE,
                    publishedAt: cached.cachedAt,
                });
            }
        }
        return map;
    }

    // ── Legacy API compatibility ────────────────────────────────────────────
    // These methods are aliases for callers that still use the old names.

    /** @deprecated Use getCachedPrice instead */
    getErPrice(productId: number): { priceUsd: number; publishedAt: number } | null {
        return this.getCachedPrice(productId);
    }

    /** @deprecated Use getAllCachedPrices instead */
    getAllErPrices(): Map<number, { priceUsd: number; publishedAt: number }> {
        return this.getAllCachedPrices();
    }

    /** @deprecated Feeds no longer exist. Returns true for any product. */
    hasFeed(_productId: number): boolean {
        return true;
    }

    /** @deprecated Feeds no longer exist. Returns all active product IDs. */
    getCreatedFeedIds(): number[] {
        return this.getActiveProductIds();
    }

    /** @deprecated No-op. Feeds no longer exist. */
    addProductToTracking(productId: number): void {
        L.info(`Product ${productId} added (no-op — feeds removed)`);
    }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: OracleKeeper | null = null;

export async function initKeeper(): Promise<OracleKeeper> {
    if (!_instance) {
        const instance = new OracleKeeper();
        try {
            await instance.init();
            _instance = instance; // Only set singleton after successful init
        } catch (e) {
            // Don't leave a half-initialized singleton
            L.error("Keeper init failed:", e);
            throw e;
        }
    }
    return _instance;
}

export function keeper(): OracleKeeper | null {
    return _instance;
}
