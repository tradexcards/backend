/**
 * Boot sequence.
 *
 *   1. Load config & create directories
 *   2. Initialize services
 *   3. Start HTTP server IMMEDIATELY (API available right away)
 *   4. Register loops
 *   5. Run initial sync in BACKGROUND (download → extract → fetch products → analyze → write top.txt)
 *   6. Initialize oracle keeper (if enabled) — after sync completes
 *   7. Start loops + keeper (ER price push runs inside the pricing loop; keeper manages commits)
 */

import { env, ensureDirectories, readActiveProductIds, readInitialFeedIds } from "./env";
import { createApp, APP_NAME, APP_VERSION } from "./app";
import { initTcgcsv, initAnalyzer, initTcgplayer } from "./services";
import { initDatabase } from "./services/db";
import { initPerpdex } from "./services/perpdex";
import { loops, dailySyncTask, pricingTask, prefetchTask, marketStatsTask, liquidationTask } from "./services/loops";
import { log } from "./log";

const boot = log("boot");
const fatal = log("fatal");

// ── Global Error Handlers ────────────────────────────────────────────────────
// Catch unhandled errors to prevent silent stalls and enable graceful recovery

process.on("unhandledRejection", (reason, promise) => {
    fatal.error("Unhandled Promise Rejection:", reason);
    fatal.error("Promise:", promise);
    // Don't exit - log and continue, but this helps identify stall causes
});

process.on("uncaughtException", (error) => {
    fatal.error("Uncaught Exception:", error);
    fatal.error("Stack:", error.stack);
    // Give time to flush logs before exit
    setTimeout(() => process.exit(1), 1000);
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────

let _shuttingDown = false;
let _serverRef: ReturnType<ReturnType<typeof createApp>["listen"]> | null = null;

async function gracefulShutdown(signal: string): Promise<void> {
    if (_shuttingDown) return;
    _shuttingDown = true;

    fatal.error(`Received ${signal} — shutting down gracefully...`);

    try {
        // 0. Stop HTTP server first (stop accepting new connections)
        if (_serverRef) {
            try {
                _serverRef.stop();
                fatal.error("HTTP server stopped");
            } catch { /* server not started */ }
        }

        // 1. Stop all background loops (pricing, prefetch, daily sync, market stats)
        loops().stopAll();
        fatal.error("Loops stopped");

        // 2. Stop WebSocket client cleanup timer
        try {
            const { stopClientCleanup } = await import("./routes/ws");
            stopClientCleanup();
            fatal.error("WS cleanup timer stopped");
        } catch { /* ws not initialized */ }

        // 3. Stop oracle keeper if running
        try {
            const { keeper } = await import("./services/oracle/keeper");
            const k = keeper();
            if (k && k.isRunning()) {
                k.stop();
                fatal.error("Oracle keeper stopped");
            }
        } catch { /* keeper not initialized */ }

        // 4. Close SQLite database
        try {
            const { closeDatabase } = await import("./services/db");
            closeDatabase();
            fatal.error("Database closed");
        } catch { /* db not initialized */ }

        fatal.error("Graceful shutdown complete");
    } catch (e) {
        fatal.error("Error during shutdown:", e);
    }

    process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── Suppress noisy Solana WebSocket errors ──────────────────────────────────
// @solana/web3.js opens persistent WSS connections that spam "ws error" when
// the devnet WebSocket endpoint is unreachable. We don't use WS subscriptions
// so these are pure noise. Filter ONLY the exact "ws error:" prefix from
// @solana/web3.js (not arbitrary errors from other libraries).
{
    const _origConsoleError = console.error;
    console.error = (...args: any[]) => {
        const first = args[0];
        if (typeof first === "string" && first === "ws error:") return;
        if (typeof first === "string" && first.startsWith("ws error: ")) return;
        _origConsoleError.apply(console, args);
    };
}

/** Read active product IDs (respects active.txt override). */
function readTopIds(count: number): number[] {
    return readActiveProductIds(count);
}

async function main(): Promise<void> {
    const cfg = env();

    console.log(`\n${"=".repeat(50)}`);
    console.log(`${APP_NAME} v${APP_VERSION}`);
    console.log(`${"=".repeat(50)}`);

    // 1. Directories
    ensureDirectories();
    boot.info(`Data dir: ${cfg.paths.data}`);

    // 1b. Initialize SQLite database (must be before services that use it)
    initDatabase(cfg.paths.data);
    boot.info(`Database: ${cfg.paths.db}`);

    // 2. Initialize services that need async setup
    await initTcgcsv();
    await initAnalyzer();
    await initTcgplayer();
    await initPerpdex();

    // 3. Start HTTP server IMMEDIATELY so API is available during sync
    const app = createApp();
    _serverRef = app.listen({ hostname: cfg.server.host, port: cfg.server.port });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Listening on http://${cfg.server.host}:${cfg.server.port}`);
    console.log(`${"=".repeat(50)}\n`);

    // 4. Register loops (but don't start them yet - wait for sync)
    loops().register("daily-sync", {
        name: "Daily Archive Sync",
        intervalMs: 24 * 60 * 60 * 1000, // 24 hours
        task: dailySyncTask(),
        immediate: false, // already ran in background init
    });

    loops().register("pricing", {
        name: "Live Pricing",
        intervalMs: cfg.pricing.intervalMs,
        task: pricingTask(),
        immediate: true, // fetch prices right after sync
    });

    loops().register("prefetch", {
        name: "Cache Prefetch",
        intervalMs: cfg.prefetch.intervalMs,
        task: prefetchTask(),
        immediate: true, // warm caches right after sync
    });

    loops().register("market-stats", {
        name: "Market Stats",
        intervalMs: 30_000, // 30 seconds — matches the pricing loop cadence
        task: marketStatsTask(),
        immediate: true, // populate cache before first dashboard request
    });

    loops().register("liquidation", {
        name: "Liquidation Scanner",
        intervalMs: 30_000, // 30 seconds — scan for underwater positions
        task: liquidationTask(),
        immediate: false, // wait for prices to be cached first
        paused: !cfg.keeper.enabled, // only run if keeper is enabled
    });

    // 5. Run initial sync in BACKGROUND (non-blocking)
    // API is already available, sync happens asynchronously
    runBackgroundInit(cfg);
}

/**
 * Background initialization: sync data, init keeper, start loops.
 * Runs after API is already listening.
 */
async function runBackgroundInit(cfg: ReturnType<typeof env>): Promise<void> {
    boot.info("Running initial sync in background...");
    
    try {
        const syncTask = dailySyncTask();
        const result = await syncTask((cur, total) => {
            if (total > 0) boot.info(`Progress: ${cur}/${total}`);
        });
        boot.info(`Initial sync complete: ${result.detail}`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        boot.error(`Initial sync failed: ${msg}`);
        boot.error("Continuing with stale/empty data - loops will retry");
    }

    // 6. Oracle signer + keeper setup (after sync completes)

    // Initialize the Ed25519 oracle signer (needed for trading endpoints to sign prices)
    try {
        const { resolve } = await import("path");
        const { existsSync, readFileSync } = await import("fs");
        const { Keypair } = await import("@solana/web3.js");
        const { initOracleSigner } = await import("./services/oracle/signer");

        const keypairPath = cfg.program.keypairPath.startsWith("/")
            ? cfg.program.keypairPath
            : resolve(cfg.paths.root, cfg.program.keypairPath);

        if (existsSync(keypairPath)) {
            const raw = JSON.parse(readFileSync(keypairPath, "utf-8"));
            const keypair = Keypair.fromSecretKey(new Uint8Array(raw));
            initOracleSigner(keypair);
            boot.info(`Oracle signer initialized: ${keypair.publicKey.toBase58()}`);
        } else {
            boot.error(`Oracle keypair not found at ${keypairPath} — trading endpoints will fail`);
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        boot.error(`Oracle signer init failed: ${msg}`);
    }

    let keeperInstance: Awaited<ReturnType<typeof import("./services/oracle/keeper").initKeeper>> | null = null;

    if (cfg.keeper.enabled) {
        boot.info("Initializing oracle keeper...");
        try {
            const { initKeeper } = await import("./services/oracle/keeper");
            keeperInstance = await initKeeper();

            // Ensure oracle state exists
            await keeperInstance.ensureOracleState();

            // Ensure markets exist for initial set (from initial-feeds.txt)
            const initialIds = readInitialFeedIds();
            if (initialIds.length > 0) {
                boot.info(`Ensuring ${initialIds.length} initial markets are created...`);
                const marketResult = await keeperInstance.ensureMarkets(initialIds);
                boot.info(`Markets: ${marketResult.created} created, ${marketResult.existing} existing, ${marketResult.errors} errors`);
            } else {
                boot.info("No initial-feeds.txt found — skipping initial market creation");
            }

            boot.info("Oracle keeper initialized (markets ready)");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            boot.error(`Oracle keeper failed to initialize: ${msg}`);
            boot.error("Backend will continue without on-chain oracle updates");
            keeperInstance = null;
        }
    } else {
        boot.info("Oracle keeper disabled (KEEPER_ENABLED=false)");
    }

    // 7. Start loops + keeper
    loops().startAll();

    if (keeperInstance) {
        keeperInstance.start();
        boot.info("Oracle keeper started (price caching)");
    }

    // 8. Schedule a re-analysis after the first prefetch completes.
    // By this point, the pricing loop will have warmed the pricing cache and
    // the prefetch loop will have warmed sales + history caches. Re-analyzing
    // gives the 3-pillar scorer full data and produces much better rankings.
    scheduleReanalysis(cfg);
}

/**
 * After the first pricing + prefetch cycle, re-run analysis with warm caches
 * so the 3-pillar scoring has full liquidity + volume data.
 */
async function scheduleReanalysis(cfg: ReturnType<typeof env>): Promise<void> {
    // Wait for the prefetch loop to complete its first run (it's the slower one)
    const waitMs = cfg.prefetch.intervalMs + 30_000; // prefetch interval + 30s buffer
    const delaySec = Math.round(waitMs / 1000);
    boot.info(`Re-analysis scheduled in ~${delaySec}s (after first prefetch cycle)`);

    setTimeout(async () => {
        try {
            const { analyzer } = await import("./services/analyzer");
            const ana = analyzer();
            boot.info("Running re-analysis with warm caches...");
            const result = await ana.analyze(true);

            // Rewrite top.txt with improved rankings (async to avoid blocking)
            const { writeFile } = await import("fs/promises");
            const { join } = await import("path");
            const topPath = join(cfg.paths.root, "top.txt");
            const lines = result.all_cards.map(c => String(c.product_id));
            await writeFile(topPath, lines.join("\n") + "\n");
            boot.info(`Re-analysis complete: ${result.all_cards.length} cards re-ranked, top.txt updated`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            boot.error(`Re-analysis failed: ${msg}`);
        }
    }, waitMs);
}

main().catch((err) => {
    fatal.error("Unhandled error:", err);
    process.exit(1);
});
