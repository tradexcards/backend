/**
 * Elysia application factory.
 *
 * Creates and configures the HTTP server with CORS and all route groups.
 * Separated from index.ts so the app can be imported for testing
 * without triggering the full boot sequence.
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";

import { dashboardRoutes, cardsRoutes, systemRoutes, oracleRoutes, tradingRoutes, referralRoutes, adminRoutes, wsRoutes } from "./routes";
import { env } from "./env";

export const APP_NAME = "tradex-backend";
export const APP_VERSION = "3.0.0";



// ── Rate Limiter ─────────────────────────────────────────────────────────────

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

/**
 * Simple in-memory rate limiter.
 * Tracks requests per IP within a sliding window.
 */
/** Max unique IPs tracked in rate limiter to prevent memory exhaustion under IP spoofing */
const RATE_LIMITER_MAX_ENTRIES = 50_000;

function createRateLimiter(maxRequests: number, windowMs: number) {
    const store = new Map<string, RateLimitEntry>();

    // Cleanup stale entries every 60s
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of store) {
            if (entry.resetAt <= now) store.delete(key);
        }
    }, 60_000);

    return {
        check(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
            const now = Date.now();
            const entry = store.get(ip);

            if (!entry || entry.resetAt <= now) {
                // Cap total entries to prevent unbounded memory growth
                if (store.size >= RATE_LIMITER_MAX_ENTRIES && !store.has(ip)) {
                    // Reject new IPs when at capacity — rate limit them
                    return { allowed: false, remaining: 0, resetAt: now + windowMs };
                }
                store.set(ip, { count: 1, resetAt: now + windowMs });
                return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
            }

            entry.count++;
            const allowed = entry.count <= maxRequests;
            return {
                allowed,
                remaining: Math.max(0, maxRequests - entry.count),
                resetAt: entry.resetAt,
            };
        },
    };
}

/** Max request body size (2 MB) to prevent memory exhaustion via large payloads */
const MAX_BODY_SIZE = 2 * 1024 * 1024;

export function createApp() {
    const allowedOrigins = env().cors.allowedOrigins;
    const isWildcard = allowedOrigins.length === 1 && allowedOrigins[0] === "*";

    // M-7: Block CORS wildcard on mainnet to prevent credential leakage
    if (isWildcard && env().program.network === "mainnet-beta") {
        throw new Error(
            "CORS_ALLOWED_ORIGINS cannot be \"*\" on mainnet-beta. " +
            "Set it to your domain (e.g., https://tradex.cards) in .env"
        );
    }

    // Rate limiter: 300 requests per minute per IP (generous for dev/testing)
    const rateLimiter = createRateLimiter(300, 60_000);

    return new Elysia({
            // WebSocket idle timeout: Cloudflare terminates idle WS connections
            // after ~100 seconds. Elysia defaults idleTimeout to 30s which is
            // too aggressive. Setting to 0 disables Bun's idle timeout entirely;
            // our application-level ping/pong (every 30s) keeps the connection
            // alive through Cloudflare, and the stale client cleanup (5 min)
            // handles truly dead connections.
            websocket: {
                idleTimeout: 0,     // disable Bun's idle timeout (Elysia default: 30s)
                sendPings: true,    // protocol-level pings to detect dead connections
            },
        })
        .use(swagger({
            path: "/api/docs",
            documentation: {
                info: {
                    title: "TradeX API",
                    version: APP_VERSION,
                    description: "Decentralized Perpetual Futures Exchange for Pokemon TCG Card Prices",
                    contact: {
                        name: "TradeX",
                        url: "https://tradex.cards",
                    },
                },
                tags: [
                    { name: "Cards", description: "Pokemon card discovery and research" },
                    { name: "Trading", description: "Trading operations and positions" },
                    { name: "Oracle", description: "Price oracle data" },
                    { name: "System", description: "System health and admin" },
                    { name: "Dashboard", description: "Dashboard and overview data" },
                    { name: "Referral", description: "Referral program" },
                ],
                servers: [
                    { url: "https://backend.tradex.cards", description: "Production" },
                    { url: "http://localhost:8001", description: "Local development" },
                ],
            },
            scalarConfig: {
                spec: {
                    url: "/api/docs/json",
                },
                darkMode: true,
                defaultHttpClient: {
                    targetKey: "node",
                    clientKey: "axios",
                },
                metaData: {
                    title: "TradeX API",
                },
                customCss: `
                    .dark-mode, .light-mode {
                        --scalar-background-1: #0b0e11;
                        --scalar-background-2: #15181c;
                        --scalar-background-3: #1e2229;
                        --scalar-border-color: #2a2e39;
                        --scalar-color-1: #f0f3fa;
                        --scalar-color-2: #848e9c;
                        --scalar-color-3: #5e6673;
                        --scalar-color-accent: #fcd535;
                        --scalar-color-green: #0ecb81;
                        --scalar-color-red: #f6465d;
                        --scalar-button-1: #fcd535;
                        --scalar-button-1-color: #000000;
                        --scalar-button-1-hover: #f0c930;
                    }
                `,
                hideClientButton: true,
            } as any,
            exclude: ["/", "/ws/*"],
        }))
        .use(cors({
            origin: isWildcard ? true : allowedOrigins,
            credentials: !isWildcard, // credentials: true is invalid with origin: "*"
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowedHeaders: ["Content-Type", "Authorization"],
        }))
        // Request body size limit (Content-Length header check)
        .onBeforeHandle(({ request, set }) => {
            const contentLength = request.headers.get("content-length");
            if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
                set.status = 413;
                return { error: "Request body too large", maxBytes: MAX_BODY_SIZE };
            }
        })
        // Actual body size enforcement for chunked/streaming requests.
        // Content-Length can be absent with chunked transfer encoding, so we
        // also check the real body size after parsing.
        // NOTE: We consume the body directly from the request (no clone) to
        // avoid doubling memory usage for large payloads (M-10 audit fix).
        .onParse(async ({ request, set, contentType }) => {
            // Only intercept JSON bodies (the only content type we accept)
            if (!contentType?.includes("application/json")) return;

            const stream = request.body;
            if (!stream) return;

            // Read the body with a size limit — consume directly, no clone
            const chunks: Uint8Array[] = [];
            let totalBytes = 0;

            for await (const chunk of stream as AsyncIterable<Uint8Array>) {
                totalBytes += chunk.byteLength;
                if (totalBytes > MAX_BODY_SIZE) {
                    set.status = 413;
                    return { error: "Request body too large", maxBytes: MAX_BODY_SIZE };
                }
                chunks.push(chunk);
            }

            // Reassemble and parse JSON
            const combined = Buffer.concat(chunks);
            try {
                return JSON.parse(combined.toString());
            } catch {
                set.status = 400;
                return { error: "Invalid JSON body" };
            }
        })
        // Rate limiting middleware
        .onBeforeHandle(({ request, set, server }) => {
            // Extract client IP.
            // When TRUST_PROXY=true (behind a reverse proxy), trust X-Forwarded-For/X-Real-IP.
            // Otherwise, use Bun's server.requestIP() to get the actual socket address.
            // This prevents spoofing via crafted headers when not behind a proxy.
            let ip: string;
            if (env().security.trustProxy) {
                ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
                    || request.headers.get("x-real-ip")
                    || "unknown";
            } else {
                const socketAddr = server?.requestIP(request);
                ip = socketAddr?.address || "unknown";
            }

            const result = rateLimiter.check(ip);
            set.headers["x-ratelimit-limit"] = "100";
            set.headers["x-ratelimit-remaining"] = String(result.remaining);
            set.headers["x-ratelimit-reset"] = String(Math.ceil(result.resetAt / 1000));

            if (!result.allowed) {
                set.status = 429;
                return {
                    error: "Too Many Requests",
                    retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
                };
            }
        })
        // Gzip compression for JSON responses — typically 85-90% size reduction.
        // Uses Bun's native gzipSync (very fast, no extra deps).
        .onAfterHandle((ctx) => {
            const response = ctx.response;

            // Only compress if client accepts gzip
            const accept = ctx.request.headers.get("accept-encoding") ?? "";
            if (!accept.includes("gzip")) return;

            // Skip already-constructed Response objects (HTML monitor, etc.)
            if (response instanceof Response) return;

            // Only compress plain objects (Elysia's JSON return) or strings
            let body: string;
            let contentType: string;

            if (typeof response === "object" && response !== null) {
                body = JSON.stringify(response);
                contentType = "application/json; charset=utf-8";
            } else if (typeof response === "string") {
                body = response;
                contentType = "text/plain; charset=utf-8";
            } else {
                return;
            }

            // Skip tiny responses (compression overhead not worth it)
            if (body.length < 1024) return;

            const compressed = Bun.gzipSync(Buffer.from(body));
            return new Response(compressed, {
                headers: {
                    "content-type": contentType,
                    "content-encoding": "gzip",
                    "vary": "Accept-Encoding",
                },
            });
        })
        // M-5: Global error handler — catch unhandled errors to prevent stack leakage
        .onError(({ code, error, set, request }) => {
            const msg = error && "message" in error ? (error as any).message : String(error);

            if (code === "NOT_FOUND") {
                // Only log 404s for /api/* routes — browser requests for favicon,
                // source maps, HMR paths etc. are expected noise.
                const url = request?.url;
                if (url && new URL(url).pathname.startsWith("/api/")) {
                    console.warn(`[404] ${new URL(url).pathname}`);
                }
                set.status = 404;
                return { error: "Not Found" };
            }
            if (code === "VALIDATION") {
                set.status = 400;
                return { error: "Validation Error", message: msg };
            }
            // Generic 500 — never expose stack traces
            set.status = 500;
            return { error: "Internal Server Error" };
        })
        .get("/", () => ({
            name: APP_NAME,
            version: APP_VERSION,
        }))
        .use(dashboardRoutes)
        .use(cardsRoutes)
        .use(systemRoutes)
        .use(oracleRoutes)
        .use(tradingRoutes)
        .use(referralRoutes)
        .use(adminRoutes)
        .use(wsRoutes);
}
