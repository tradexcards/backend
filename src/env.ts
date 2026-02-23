/**
 * Environment & configuration.
 *
 * Single source of truth. Resolution order per field:
 *   1. Environment variable  (highest priority — secrets, deploy-time knobs)
 *   2. Hardcoded default     (lowest priority — sane dev defaults)
 *
 * No hidden merge layers, no separate "values" file.
 * Every setting is readable from ONE place.
 */

import { join, dirname } from "path";
import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync } from "fs";
import { log } from "./log";

// ── Env helpers ─────────────────────────────────────────────────────────────

function str(key: string, fallback: string): string {
    return process.env[key] ?? fallback;
}

/** Require an env var — throw clear error if missing. */
function strRequired(key: string): string {
    const v = process.env[key];
    if (!v || v.trim() === "") {
        throw new Error(`Missing required environment variable: ${key}. Check your .env file.`);
    }
    return v;
}

function num(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
    const raw = process.env[key] || process.env["BUN_PUBLIC_" + key]; // Support both BUN_PUBLIC_* and non-prefixed for flexibility
    if (raw === undefined) return fallback;
    return raw === "true" || raw === "1";
}

// ── Network Configs ─────────────────────────────────────────────────────────

interface NetworkConfig {
    network: "mainnet-beta" | "devnet";
    programId: string;
    usdcMint: string;
    rpcUrl: string;
}

/** Get network config based on MAINNET env flag */
function getNetworkConfig(): NetworkConfig {
    const isMainnet = bool("MAINNET", false);
    
    if (isMainnet) {
        return {
            network: "mainnet-beta",
            programId: strRequired("PROGRAM_ID"),
            usdcMint: str("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
            rpcUrl: strRequired("SOLANA_RPC_URL"),
        };
    }
    
    // Devnet: PROGRAM_ID is required (no default - deploy your own)
    return {
        network: "devnet",
        programId: strRequired("PROGRAM_ID"),
        usdcMint: str("USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
        rpcUrl: str("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    };
}

// ── Paths ───────────────────────────────────────────────────────────────────

const ROOT = join(dirname(import.meta.path), "..");
const DATA = join(ROOT, "src", "data");

const paths = {
    /** Project root (backend/) */
    root: ROOT,
    /** Persistent data directory (backend/src/data/) */
    data: DATA,
    /** Downloaded .ppmd.7z daily archives from tcgcsv.com */
    archives: join(DATA, "archives"),
    /** Extracted JSON files from the daily archives */
    archivesJson: join(DATA, "archives_json"),
    /** File-backed cache directory for all PersistentCache instances (legacy) */
    cache: join(DATA, "cache"),
    /** SQLite database file for all card data */
    db: join(DATA, "cards.db"),
} as const;

// ── Tradable product IDs ────────────────────────────────────────────────────

/**
 * Load manually curated product IDs from products.txt (one per line).
 * Used as the tradable set for the oracle. Lines starting with # are ignored.
 */
function loadProductIds(): number[] {
    const file = join(ROOT, "products.txt");
    try {
        if (!existsSync(file)) return [];
        return readFileSync(file, "utf-8")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith("#"))
            .map((l) => parseInt(l, 10))
            .filter((id) => Number.isFinite(id) && id > 0);
    } catch {
        log("env").warn("products.txt not found — using empty list");
        return [];
    }
}

// ── Config shape ────────────────────────────────────────────────────────────

export interface Env {
    readonly paths: typeof paths;

    readonly server: {
        /** HOST — Bind address for the HTTP server. */
        readonly host: string;
        /** PORT — Port to listen on. */
        readonly port: number;
        /** DEBUG — Enable verbose logging. */
        readonly debug: boolean;
    };

    readonly tcgcsv: {
        /** TCGCSV_ARCHIVE_URL — Base URL for daily .ppmd.7z archive downloads. */
        readonly archiveUrl: string;
        /** TCGCSV_BASE_URL — Base URL for the tcgcsv.com product catalog API. */
        readonly baseUrl: string;
        /** ARCHIVE_START_DATE — Earliest date to look for archives (YYYY-MM-DD). */
        readonly archiveStartDate: string;
        /** ARCHIVE_RETENTION_DAYS — How many days of archives to keep on disk. */
        readonly retentionDays: number;
    };

    readonly tcgplayer: {
        /** TCGPLAYER_SEARCH_API — Base URL for TCGPlayer search/listings API. */
        readonly searchApi: string;
        /** TCGPLAYER_MP_API — Base URL for TCGPlayer marketplace API (sales). */
        readonly mpApi: string;
        /** TCGPLAYER_HISTORY_API — Base URL for TCGPlayer price history API. */
        readonly historyApi: string;
        /** USER_AGENT — User-Agent header sent with all TCGPlayer requests. */
        readonly userAgent: string;
    };

    readonly cache: {
        /** CACHE_TTL_PRICING — TTL for live pricing cache in seconds. */
        readonly pricing: number;
        /** CACHE_TTL_LISTINGS — TTL for marketplace listings cache in seconds. */
        readonly listings: number;
        /** CACHE_TTL_SALES — TTL for recent sales cache in seconds. */
        readonly sales: number;
        /** CACHE_TTL_HISTORY — TTL for price history cache in seconds. */
        readonly history: number;
        /** CACHE_TTL_PRODUCT_INFO — TTL for static product info cache in seconds. */
        readonly productInfo: number;
        /** CACHE_TTL_DETAILS — TTL for combined product details cache in seconds. */
        readonly details: number;
    };

    readonly rateLimit: {
        /** RATE_DELAY — Default delay between sequential API requests (seconds). */
        readonly delaySeconds: number;
        /** RATE_MAX_CONCURRENT — Max concurrent outbound API requests. */
        readonly maxConcurrent: number;
        /** RATE_TIMEOUT — Per-request timeout for outbound API calls (seconds). */
        readonly timeoutSeconds: number;
        /** Hot path rate limits — used for high-priority/time-sensitive fetches. */
        readonly hot: {
            /** RATE_HOT_DELAY — Delay between hot-path requests (seconds). */
            readonly delaySeconds: number;
            /** RATE_HOT_MAX_CONCURRENT — Max concurrent hot-path requests. */
            readonly maxConcurrent: number;
        };
    };

    readonly proxy: {
        /** PROXY_ENABLED — Whether to route TCGPlayer requests through Bright Data proxy. */
        readonly enabled: boolean;
        /** PROXY_HOST — Proxy hostname. */
        readonly host: string;
        /** PROXY_PORT — Proxy port. */
        readonly port: number;
        /** PROXY_USER — Proxy authentication username. */
        readonly user: string;
        /** PROXY_PASS — Proxy authentication password. */
        readonly pass: string;
        /** PROXY_COUNTRY — Two-letter country code for proxy exit node. */
        readonly country: string;
        /** PROXY_CA_CERT_PATH — Path to the Bright Data CA certificate (required for HTTPS proxying). */
        readonly caCertPath: string;
    };

    readonly analysis: {
        /** TCGPlayer category IDs to include in analysis (3 = Pokemon, 85 = Pokemon JP). */
        readonly categories: readonly number[];
        /** MIN_DATA_POINTS — Minimum daily data points required for a card to be analyzed. */
        readonly minDataPoints: number;
        /** ROLLING_WINDOW_DAYS — Number of days for the rolling activity analysis window. */
        readonly rollingWindowDays: number;
    };

    readonly scheduler: {
        /** CRON_HOUR — Hour (0-23) for the daily sync cron job. */
        readonly cronHour: number;
        /** CRON_MINUTE — Minute (0-59) for the daily sync cron job. */
        readonly cronMinute: number;
    };

    readonly admin: {
        /** ADMIN_PASSWORD — Password for admin-only endpoints. Empty = disabled. */
        readonly password: string;
    };

    readonly pricing: {
        /** PRICING_TOP_PRODUCT_COUNT — How many top products (from top.txt) to fetch live prices for. */
        readonly topProductCount: number;
        /** PRICING_INTERVAL_MS — How often the live pricing loop runs (milliseconds). */
        readonly intervalMs: number;
    };

    readonly prefetch: {
        /** PREFETCH_TOP_COUNT — Number of top products to keep warm in listings/sales/history caches. */
        readonly topCount: number;
        /** PREFETCH_BATCH_SIZE — How many products to prefetch concurrently per batch. */
        readonly batchSize: number;
        /** PREFETCH_PRICING_BATCH_SIZE — Batch size for pricing prefetch (unused currently). */
        readonly pricingBatchSize: number;
        /** PREFETCH_INTERVAL_MS — How often the cache prefetch loop runs (milliseconds). */
        readonly intervalMs: number;
    };

    readonly solana: {
        /** SOLANA_RPC_URL — Primary Solana RPC endpoint. */
        readonly rpcUrl: string;
        /** SOLANA_RPC_FALLBACK_URL — Fallback RPC (e.g. public endpoint). */
        readonly rpcFallbackUrl: string | null;
    };

    readonly keeper: {
        /** KEEPER_ENABLED — Whether the oracle keeper auto-updates on-chain price feeds. */
        readonly enabled: boolean;
        /** KEEPER_UPDATE_INTERVAL — Seconds between keeper update cycles. */
        readonly updateInterval: number;
        /** KEEPER_TX_BATCH_SIZE — Max transactions to send per keeper cycle. */
        readonly txBatchSize: number;
        /** KEEPER_CYCLE_BATCH_SIZE — Max products to process per keeper cycle. */
        readonly cycleBatchSize: number;
        /** KEEPER_KEYPAIR_PATH — Path to the Solana keypair JSON file for signing transactions. */
        readonly keypairPath: string;
    };

    readonly program: {
        /** PROGRAM_ID — Solana program ID of the merged oracle+perpdex program. */
        readonly programId: string;
        /** ORACLE_KEYPAIR_PATH — Path to the oracle signer keypair JSON. */
        readonly keypairPath: string;
        /** ORACLE_NETWORK — Solana cluster to use. */
        readonly network: "devnet" | "mainnet-beta";
        /** ORACLE_MAX_PRICE_AGE — Maximum age (seconds) before a price is considered stale. */
        readonly maxPriceAgeSeconds: number;
        /** USDC_MINT — USDC mint address (differs between devnet and mainnet). */
        readonly usdcMint: string;
    };

    readonly cors: {
        /** CORS_ALLOWED_ORIGINS — Comma-separated list of allowed origins (or "*" for dev). */
        readonly allowedOrigins: string[];
    };

    readonly security: {
        /** TRUST_PROXY — When true, trust X-Forwarded-For/X-Real-IP for client IP. Only enable behind a reverse proxy. */
        readonly trustProxy: boolean;
    };

    /** Manually curated product IDs from products.txt — the tradable set for the oracle. */
    readonly tradableProductIds: readonly number[];
}

// ── Build config (lazy singleton) ───────────────────────────────────────────

let _env: Env | null = null;

export function env(): Env {
    if (_env) return _env;

    _env = {
        paths,

        server: {
            host: str("HOST", "0.0.0.0"),
            port: num("PORT", 8001),
            debug: bool("DEBUG", false),
        },

        tcgcsv: {
            archiveUrl: str("TCGCSV_ARCHIVE_URL", "https://tcgcsv.com/archive/tcgplayer"),
            baseUrl: str("TCGCSV_BASE_URL", "https://tcgcsv.com/tcgplayer"),
            archiveStartDate: str("ARCHIVE_START_DATE", "2024-02-08"),
            retentionDays: num("ARCHIVE_RETENTION_DAYS", 64),
        },

        tcgplayer: {
            searchApi: str("TCGPLAYER_SEARCH_API", "https://mp-search-api.tcgplayer.com"),
            mpApi: str("TCGPLAYER_MP_API", "https://mpapi.tcgplayer.com"),
            historyApi: str("TCGPLAYER_HISTORY_API", "https://infinite-api.tcgplayer.com"),
            userAgent: str(
                "USER_AGENT",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0",
            ),
        },

        cache: {
            pricing: num("CACHE_TTL_PRICING", 300),             // 5 min
            listings: num("CACHE_TTL_LISTINGS", 21_600),        // 6 hr
            sales: num("CACHE_TTL_SALES", 21_600),              // 6 hr
            history: num("CACHE_TTL_HISTORY", 21_600),          // 6 hr
            productInfo: num("CACHE_TTL_PRODUCT_INFO", 2_592_000), // 30 days
            details: num("CACHE_TTL_DETAILS", 86_400),          // 24 hr
        },

        rateLimit: {
            delaySeconds: num("RATE_DELAY", 2),
            maxConcurrent: num("RATE_MAX_CONCURRENT", 3),
            timeoutSeconds: num("RATE_TIMEOUT", 30),
            hot: {
                delaySeconds: num("RATE_HOT_DELAY", 0.5),
                maxConcurrent: num("RATE_HOT_MAX_CONCURRENT", 5),
            },
        },

        proxy: {
            enabled: bool("PROXY_ENABLED", false),
            host: str("PROXY_HOST", "brd.superproxy.io"),
            port: num("PROXY_PORT", 33335),
            user: str("PROXY_USER", ""),
            pass: str("PROXY_PASS", ""),
            country: str("PROXY_COUNTRY", "de"),
            caCertPath: str("PROXY_CA_CERT_PATH", "../brightdata_proxy_ca/New SSL certifcate - MUST BE USED WITH PORT 33335/BrightData SSL certificate (port 33335).crt"),
        },

        analysis: {
            categories: [3, 85] as const,
            minDataPoints: num("MIN_DATA_POINTS", 7),
            rollingWindowDays: num("ROLLING_WINDOW_DAYS", 64),
        },

        scheduler: {
            cronHour: num("CRON_HOUR", 6),
            cronMinute: num("CRON_MINUTE", 0),
        },

        admin: {
            password: str("ADMIN_PASSWORD", ""),
        },

        pricing: {
            topProductCount: num("PRICING_TOP_PRODUCT_COUNT", 100),
            intervalMs: num("PRICING_INTERVAL_MS", 30_000), // 30 sec
        },

        prefetch: {
            topCount: num("PREFETCH_TOP_COUNT", 100),
            batchSize: num("PREFETCH_BATCH_SIZE", 4),
            pricingBatchSize: num("PREFETCH_PRICING_BATCH_SIZE", 15),
            intervalMs: num("PREFETCH_INTERVAL_MS", 6 * 60 * 60 * 1000), // 6 hours
        },

        solana: {
            rpcUrl: getNetworkConfig().rpcUrl,
            rpcFallbackUrl: process.env["SOLANA_RPC_FALLBACK_URL"] || null,
        },

        program: (() => {
            const netConfig = getNetworkConfig();
            return {
                programId: netConfig.programId,
                keypairPath: str("ORACLE_KEYPAIR_PATH", "../keypair.json"),
                network: netConfig.network,
                maxPriceAgeSeconds: num("ORACLE_MAX_PRICE_AGE", 15),
                usdcMint: netConfig.usdcMint,
            };
        })(),

        cors: {
            allowedOrigins: bool("MAINNET", false)
                ? ["https://tradex.cards", "https://www.tradex.cards", "https://pokeperps.fun", "https://www.pokeperps.fun"]
                : ["*"],
        },

        security: {
            trustProxy: bool("TRUST_PROXY", false),
        },

        keeper: {
            enabled: bool("KEEPER_ENABLED", true),
            updateInterval: num("KEEPER_UPDATE_INTERVAL", 300),
            txBatchSize: num("KEEPER_TX_BATCH_SIZE", 10),
            cycleBatchSize: num("KEEPER_CYCLE_BATCH_SIZE", 100),
            keypairPath: str("KEEPER_KEYPAIR_PATH", "../keypair.json"),
        },

        tradableProductIds: loadProductIds(),
    };

    // ── Startup validation ──────────────────────────────────────────────
    // Ensure program ID is a valid base58 pubkey, not a placeholder
    const programId = _env.program.programId;
    if (programId.includes("DEPLOY") || programId.includes("TODO") || programId.includes("CHANGE")) {
        throw new Error(`PROGRAM_ID is a placeholder ("${programId}"). Deploy the program and set the real ID.`);
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(programId)) {
        throw new Error(`PROGRAM_ID is not a valid Solana public key: "${programId}"`);
    }

    // Mainnet guards
    if (_env.program.network === "mainnet-beta") {
        if (!str("SOLANA_RPC_URL", "")) {
            throw new Error("SOLANA_RPC_URL must be set for mainnet. Refusing to start.");
        }
        if (!_env.admin.password || _env.admin.password.length < 16) {
            throw new Error("ADMIN_PASSWORD must be set (16+ chars) for mainnet. Refusing to start.");
        }
    }

    // Warn on weak admin password (devnet)
    if (_env.admin.password && (_env.admin.password === "CHANGE_ME_FOR_PRODUCTION" || _env.admin.password.length < 16)) {
        log("env").warn("ADMIN_PASSWORD is weak or placeholder — change it for production!");
    }

    return _env;
}

// ── Directory setup ─────────────────────────────────────────────────────────

export function ensureDirectories(): void {
    const { data, archives, archivesJson, cache } = env().paths;
    for (const dir of [data, archives, archivesJson, cache]) {
        mkdirSync(dir, { recursive: true });
    }
}

// ── Active product IDs ──────────────────────────────────────────────────────

/**
 * Read product IDs from a file (one per line, # comments ignored).
 * Returns empty array if file doesn't exist.
 */
function readIdFile(filePath: string): number[] {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, "utf-8")
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith("#"))
        .map(l => parseInt(l, 10))
        .filter(id => Number.isFinite(id) && id > 0);
}

/**
 * Get the active product IDs to use across the system.
 *
 * Resolution:
 *   1. If `active.txt` exists in the backend root, use ONLY those IDs
 *      in the order they appear. The `topN` cap is ignored.
 *   2. Otherwise, take the first `topN` IDs from top.txt.
 *
 * This is the single source of truth for "which products are we tracking".
 * Results are cached and invalidated when the file's mtime changes.
 */
let _activeCache: { ids: number[]; mtimeMs: number; path: string } | null = null;

export function readActiveProductIds(topN: number): number[] {
    const root = env().paths.root;
    const activePath = join(root, "active.txt");

    // Determine which file to read
    const useActive = existsSync(activePath);
    const filePath = useActive ? activePath : join(root, "top.txt");

    // Check mtime for cache invalidation
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(filePath).mtimeMs;
    } catch {
        // File doesn't exist
        return [];
    }

    if (_activeCache && _activeCache.path === filePath && _activeCache.mtimeMs === mtimeMs) {
        return useActive ? _activeCache.ids : _activeCache.ids.slice(0, topN);
    }

    const ids = readIdFile(filePath);
    _activeCache = { ids, mtimeMs, path: filePath };
    return useActive ? ids : ids.slice(0, topN);
}

/**
 * Read the product IDs that should have on-chain feeds + markets created on boot.
 * Reads from `initial-feeds.txt` in the backend root.
 * This is intentionally separate from active.txt — we only create on-chain accounts
 * for a small set on boot (budget constraint), while active.txt drives pricing/prefetch
 * for all tradable products.
 */
export function readInitialFeedIds(): number[] {
    const root = env().paths.root;
    return readIdFile(join(root, "initial-feeds.txt"));
}

/**
 * Cached Set version of readActiveProductIds for O(1) membership checks.
 * Rebuilds when the underlying array changes length (file changes are rare).
 */
let _activeSetCache: { ids: Set<number>; size: number } | null = null;

export function readActiveProductIdSet(): Set<number> {
    const arr = readActiveProductIds(Infinity);
    if (_activeSetCache && _activeSetCache.size === arr.length) {
        return _activeSetCache.ids;
    }
    const ids = new Set(arr);
    _activeSetCache = { ids, size: arr.length };
    return ids;
}

/**
 * Add a product ID to active.txt (creates file if needed).
 * Returns true if added, false if already exists.
 */
export function addToActiveList(productId: number): boolean {
    const root = env().paths.root;
    const activePath = join(root, "active.txt");

    // Read existing IDs
    let existingIds: number[] = [];
    if (existsSync(activePath)) {
        existingIds = readIdFile(activePath);
    }

    // Check if already exists
    if (existingIds.includes(productId)) {
        return false;
    }

    // Append to file
    const content = existsSync(activePath)
        ? readFileSync(activePath, "utf8")
        : "";
    const newContent = content.endsWith("\n") || content === ""
        ? `${content}${productId}\n`
        : `${content}\n${productId}\n`;

    writeFileSync(activePath, newContent, "utf8");

    // Invalidate cache
    _activeCache = null;
    _activeSetCache = null;

    return true;
}
