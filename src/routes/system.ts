/**
 * System routes — /api/system
 *
 * Endpoints:
 *   GET  /health            health check
 *   GET  /health/detailed   detailed health with service status
 *   GET  /status            full system status + config
 *   POST /sync              trigger archive pipeline (background, admin-only)
 *   GET  /sync/last         last pipeline results
 *   POST /cache/clear       clear caches (admin-only)
 *   GET  /cache/stats       cache statistics
 */

import { Elysia } from "elysia";
import { APP_VERSION } from "../app";
import { env } from "../env";
import { loops } from "../services/loops";
import { getClientCount } from "./ws";
import type { HealthResponse } from "../models/api";
import { timingSafeEqual } from "../utils/crypto";

// Track process start time for uptime calculation
const startTime = Date.now();

// Track last sync result
let lastSyncResult: { status: string; detail: string; startedAt: string; finishedAt: string } | null = null;

/**
 * Simple admin auth check. Returns null if authorized, error string otherwise.
 */
function checkAdminAuth(request: Request): string | null {
    const password = env().admin.password;
    if (!password) return "Admin password not configured";

    const auth = request.headers.get("authorization");
    if (!auth) return "Authorization header required";

    // Accept "Bearer <password>" or "Basic <base64(admin:password)>"
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

export const systemRoutes = new Elysia({ prefix: "/api/system" })
    .get("/health", (): HealthResponse => ({
        status: "ok",
        version: APP_VERSION,
        timestamp: new Date().toISOString(),
    }), {
        detail: {
            tags: ["System"],
            summary: "Health check",
            description: "Simple health check for load balancers",
        },
    })

    .get("/openapi.json", ({ redirect }) => redirect("/api/docs/json"), {
        detail: {
            tags: ["System"],
            summary: "OpenAPI spec",
            description: "Redirects to auto-generated OpenAPI specification",
        },
    })
    
    .get("/health/detailed", async () => {
        const loopManager = loops();
        const loopStatus = loopManager.getStatus();
        
        // Check if any loops are stuck (last run was too long ago)
        const now = Date.now();
        const loopHealth = loopStatus.map(loop => {
            const lastRun = loop.lastRunAt ? new Date(loop.lastRunAt).getTime() : 0;
            const expectedInterval = loop.intervalMs;
            const timeSinceRun = now - lastRun;
            // Consider stuck if more than 3x the interval has passed
            const isStuck = lastRun > 0 && timeSinceRun > expectedInterval * 3;
            
            return {
                name: loop.name,
                state: loop.state,
                isStuck,
                lastRunAt: loop.lastRunAt,
                timeSinceRunMs: lastRun > 0 ? timeSinceRun : null,
            };
        });
        
        // Try to get keeper status if available
        let keeperStatus: { running: boolean; stats?: any } | null = null;
        try {
            const { keeper } = await import("../services/oracle/keeper");
            const k = keeper();
            if (k) {
                keeperStatus = {
                    running: k.isRunning(),
                    stats: k.getStats(),
                };
            }
        } catch { /* keeper not initialized */ }
        
        // Overall health: ok if no loops are stuck
        const allLoopsHealthy = loopHealth.every(l => !l.isStuck && l.state === "running");
        const status = allLoopsHealthy ? "ok" : "degraded";
        
        return {
            status,
            version: APP_VERSION,
            timestamp: new Date().toISOString(),
            uptime: {
                ms: now - startTime,
                human: formatUptime(now - startTime),
            },
            services: {
                loops: {
                    healthy: allLoopsHealthy,
                    details: loopHealth,
                },
                websocket: {
                    clients: getClientCount(),
                },
                keeper: keeperStatus,
            },
            memory: {
                heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
            },
        };
    }, {
        detail: {
            tags: ["System"],
            summary: "Detailed health check",
            description: "Detailed health status with service info, loops, and memory usage",
        },
    })

    // ── Sync ─────────────────────────────────────────────────────────────────

    .post("/sync", async ({ request, set }) => {
        const authErr = checkAdminAuth(request);
        if (authErr) { set.status = 401; return { error: authErr }; }

        // Trigger sync in background
        const startedAt = new Date().toISOString();
        try {
            const { dailySyncTask } = await import("../services/loops");
            const task = dailySyncTask();
            // Run in background — don't await
            task(() => {}).then(result => {
                lastSyncResult = {
                    status: "completed",
                    detail: result.detail ?? "Sync completed",
                    startedAt,
                    finishedAt: new Date().toISOString(),
                };
            }).catch(err => {
                lastSyncResult = {
                    status: "failed",
                    detail: err instanceof Error ? err.message : String(err),
                    startedAt,
                    finishedAt: new Date().toISOString(),
                };
            });

            return {
                status: "started",
                message: "Sync started in background. Check /api/system/sync/last for results.",
                startedAt,
            };
        } catch (e: any) {
            const { log } = await import("../log");
            log("system").error("Sync trigger failed:", e);
            return { error: "Failed to start sync" };
        }
    }, {
        detail: {
            tags: ["System"],
            summary: "Trigger sync",
            description: "Trigger archive pipeline sync (admin-only, runs in background)",
        },
    })

    .get("/sync/last", () => {
        if (!lastSyncResult) {
            return { status: "none", message: "No sync has been triggered yet" };
        }
        return lastSyncResult;
    }, {
        detail: {
            tags: ["System"],
            summary: "Last sync result",
            description: "Get the result of the last triggered sync operation",
        },
    })

    // ── Cache ────────────────────────────────────────────────────────────────

    .post("/cache/clear", async ({ request, set }) => {
        const authErr = checkAdminAuth(request);
        if (authErr) { set.status = 401; return { error: authErr }; }

        try {
            // Clear the file-backed caches
            const { existsSync, readdirSync, unlinkSync } = await import("fs");
            const { join } = await import("path");
            const cacheDir = env().paths.cache;

            let cleared = 0;
            if (existsSync(cacheDir)) {
                const files = readdirSync(cacheDir);
                for (const file of files) {
                    try {
                        unlinkSync(join(cacheDir, file));
                        cleared++;
                    } catch { /* ignore individual file errors */ }
                }
            }

            return {
                status: "cleared",
                filesRemoved: cleared,
                timestamp: new Date().toISOString(),
            };
        } catch (e: any) {
            return { error: "Failed to clear cache" };
        }
    }, {
        detail: {
            tags: ["System"],
            summary: "Clear cache",
            description: "Clear all file-backed caches (admin-only)",
        },
    })

    .get("/cache/stats", async () => {
        try {
            const { existsSync, readdirSync, statSync } = await import("fs");
            const { join } = await import("path");
            const cacheDir = env().paths.cache;

            let fileCount = 0;
            let totalSizeBytes = 0;

            if (existsSync(cacheDir)) {
                const files = readdirSync(cacheDir);
                fileCount = files.length;
                for (const file of files) {
                    try {
                        const stat = statSync(join(cacheDir, file));
                        totalSizeBytes += stat.size;
                    } catch { /* ignore individual file errors */ }
                }
            }

            // Get perpdex market stats cache info
            const { perpdex } = await import("../services/perpdex");
            const svc = perpdex();
            const marketStatsAge = svc.getMarketStatsCacheAge();
            const marketStatsCount = svc.getCachedMarketStats().size;

            return {
                disk: {
                    directory: cacheDir,
                    files: fileCount,
                    totalSizeMB: Math.round(totalSizeBytes / 1024 / 1024 * 100) / 100,
                },
                memory: {
                    marketStats: {
                        entries: marketStatsCount,
                        ageMs: marketStatsAge === Infinity ? null : marketStatsAge,
                    },
                },
                timestamp: new Date().toISOString(),
            };
        } catch (e: any) {
            return { error: "Failed to retrieve cache stats" };
        }
    }, {
        detail: {
            tags: ["System"],
            summary: "Cache statistics",
            description: "Get disk and memory cache statistics",
        },
    });

function formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}
