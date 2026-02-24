/**
 * WebSocket Routes for Real-Time Updates
 * 
 * Provides real-time updates to all connected clients for:
 * - Price updates (from pricing loop)
 * - Trading events (positions opened/closed, markets created)
 * - Market stats changes (open interest updates)
 * 
 * Connection Management:
 * - Per-IP connection limits to prevent abuse
 * - Heartbeat-based stale connection detection
 * - Automatic cleanup of orphan connections
 */

import { Elysia } from "elysia";
import { log } from "../log";

const logger = log("ws");

// ── Types ────────────────────────────────────────────────────────────────────

export type WsMessageType = 
    | "price_update"
    | "position_opened"
    | "position_closed"
    | "market_created"
    | "market_stats"
    | "account_update"
    | "ping";

export interface WsMessage {
    type: WsMessageType;
    data: any;
    timestamp: number;
}

interface WsClient {
    id: string;
    ws: any;
    ip: string;
    subscribedProducts: Set<number>;
    subscribedAccounts: Set<string>;
    lastPing: number;      // Last time we sent a ping
    lastPong: number;      // Last time we received a pong (or any message)
    isAlive: boolean;      // Whether connection is responsive
    connectedAt: number;   // Connection timestamp
}

// ── Configuration ────────────────────────────────────────────────────────────

const MAX_CLIENTS = 1000;
const MAX_CLIENTS_PER_IP = 25;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 500;

// Heartbeat: Server pings clients every 30s, expects pong within 10s
const HEARTBEAT_INTERVAL = 30_000;
const PONG_TIMEOUT = 10_000;

// Cleanup runs every 15s to catch any stale connections
const CLEANUP_INTERVAL = 15_000;

// ── Client Registry ──────────────────────────────────────────────────────────

class ClientRegistry {
    private clients = new Map<string, WsClient>();
    private ipCounts = new Map<string, number>();
    private clientIdCounter = 0;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    generateId(): string {
        return `ws_${++this.clientIdCounter}_${Date.now().toString(36)}`;
    }

    get size(): number {
        return this.clients.size;
    }

    getIpCount(ip: string): number {
        return this.ipCounts.get(ip) || 0;
    }

    canAcceptConnection(ip: string): { ok: boolean; reason?: string } {
        if (this.clients.size >= MAX_CLIENTS) {
            return { ok: false, reason: `Server at capacity (${MAX_CLIENTS} connections)` };
        }
        if (this.getIpCount(ip) >= MAX_CLIENTS_PER_IP) {
            return { ok: false, reason: `Too many connections from IP (max ${MAX_CLIENTS_PER_IP})` };
        }
        return { ok: true };
    }

    register(client: WsClient): void {
        this.clients.set(client.id, client);
        this.ipCounts.set(client.ip, this.getIpCount(client.ip) + 1);
        logger.info(`Client connected: ${client.id} from ${client.ip} (total: ${this.size})`);
    }

    unregister(clientId: string): WsClient | undefined {
        const client = this.clients.get(clientId);
        if (!client) return undefined;

        this.clients.delete(clientId);
        
        const ipCount = this.getIpCount(client.ip);
        if (ipCount <= 1) {
            this.ipCounts.delete(client.ip);
        } else {
            this.ipCounts.set(client.ip, ipCount - 1);
        }

        logger.info(`Client disconnected: ${clientId} (remaining: ${this.size})`);
        return client;
    }

    get(clientId: string): WsClient | undefined {
        return this.clients.get(clientId);
    }

    forEach(fn: (client: WsClient, id: string) => void): void {
        this.clients.forEach(fn);
    }

    // Start heartbeat and cleanup timers
    startTimers(): void {
        if (this.heartbeatTimer) return;

        // Heartbeat: ping all clients periodically
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeats();
        }, HEARTBEAT_INTERVAL);

        // Cleanup: remove dead connections
        this.cleanupTimer = setInterval(() => {
            this.cleanupStaleClients();
        }, CLEANUP_INTERVAL);
    }

    stopTimers(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    private sendHeartbeats(): void {
        const now = Date.now();
        const pingMsg = JSON.stringify({ 
            type: "server_ping", 
            timestamp: now 
        });

        for (const [id, client] of this.clients) {
            // Check if previous ping was answered
            if (client.lastPing > 0 && !client.isAlive) {
                // Client didn't respond to last ping, mark for removal
                const timeSinceLastPong = now - client.lastPong;
                if (timeSinceLastPong > PONG_TIMEOUT) {
                    logger.warn(`Client ${id} unresponsive (${Math.round(timeSinceLastPong / 1000)}s), closing`);
                    this.terminateClient(id);
                    continue;
                }
            }

            // Mark as awaiting pong and send ping
            client.isAlive = false;
            client.lastPing = now;

            try {
                client.ws.send(pingMsg);
            } catch (e) {
                logger.warn(`Failed to ping ${id}, terminating`);
                this.terminateClient(id);
            }
        }
    }

    private cleanupStaleClients(): void {
        const now = Date.now();
        let removed = 0;

        for (const [id, client] of this.clients) {
            // If no activity for 2 full heartbeat cycles, consider dead
            const staleThreshold = HEARTBEAT_INTERVAL * 2 + PONG_TIMEOUT;
            if (now - client.lastPong > staleThreshold) {
                logger.warn(`Removing stale client ${id} (no activity for ${Math.round((now - client.lastPong) / 1000)}s)`);
                this.terminateClient(id);
                removed++;
            }
        }

        if (removed > 0) {
            logger.info(`Cleaned up ${removed} stale clients (remaining: ${this.size})`);
        }
    }

    private terminateClient(clientId: string): void {
        const client = this.clients.get(clientId);
        if (!client) return;

        try {
            client.ws.close(1000, "Connection stale");
        } catch { /* ignore */ }

        this.unregister(clientId);
    }

    // Mark client as alive (received pong or any message)
    markAlive(clientId: string): void {
        const client = this.clients.get(clientId);
        if (client) {
            client.isAlive = true;
            client.lastPong = Date.now();
        }
    }
}

const registry = new ClientRegistry();
registry.startTimers();

// ── Exports for external use ─────────────────────────────────────────────────

export function getClientCount(): number {
    return registry.size;
}

export function stopClientCleanup(): void {
    registry.stopTimers();
}

// ── Broadcasting ─────────────────────────────────────────────────────────────

function sendToClient(client: WsClient, payload: string): boolean {
    try {
        client.ws.send(payload);
        return true;
    } catch (e) {
        logger.warn(`Failed to send to ${client.id}, removing`);
        registry.unregister(client.id);
        return false;
    }
}

/**
 * Broadcast a message to all connected clients (unfiltered).
 */
export function broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;

    registry.forEach((client) => {
        if (sendToClient(client, payload)) sent++;
    });

    if (sent > 0) {
        logger.debug(`Broadcast ${message.type} to ${sent} clients`);
    }
}

/**
 * Send a message only to clients subscribed to a specific product.
 * Empty subscribedProducts = "subscribed to all" (backward compat)
 */
function broadcastToProduct(productId: number, message: WsMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;

    registry.forEach((client) => {
        if (client.subscribedProducts.size > 0 && !client.subscribedProducts.has(productId)) {
            return;
        }
        if (sendToClient(client, payload)) sent++;
    });

    if (sent > 0) {
        logger.debug(`Broadcast ${message.type} (product=${productId}) to ${sent} clients`);
    }
}

/**
 * Send a message only to clients subscribed to a specific account.
 */
function broadcastToAccount(owner: string, message: WsMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;

    registry.forEach((client) => {
        if (client.subscribedAccounts.size > 0 && !client.subscribedAccounts.has(owner)) {
            return;
        }
        if (sendToClient(client, payload)) sent++;
    });

    if (sent > 0) {
        logger.debug(`Broadcast ${message.type} (account=${owner.slice(0, 8)}...) to ${sent} clients`);
    }
}

/**
 * Broadcast price updates — filtered by product subscription.
 */
export function broadcastPriceUpdate(prices: Array<{ productId: number; price: number; source: string }>): void {
    if (prices.length === 0) return;

    const allPricesMsg: WsMessage = {
        type: "price_update",
        data: { prices },
        timestamp: Date.now(),
    };

    registry.forEach((client) => {
        try {
            if (client.subscribedProducts.size === 0) {
                // No filter — send all prices
                client.ws.send(JSON.stringify(allPricesMsg));
            } else {
                // Filter to only subscribed products
                const filtered = prices.filter(p => client.subscribedProducts.has(p.productId));
                if (filtered.length > 0) {
                    client.ws.send(JSON.stringify({
                        type: "price_update",
                        data: { prices: filtered },
                        timestamp: Date.now(),
                    }));
                }
            }
        } catch (e) {
            logger.warn(`Failed to send price update to ${client.id}, removing`);
            registry.unregister(client.id);
        }
    });
}

/**
 * Broadcast when a position is opened
 */
export function broadcastPositionOpened(data: {
    owner: string;
    productId: number;
    side: "long" | "short";
    size: number;
    leverage: number;
    entryPrice: number;
}): void {
    broadcastToProduct(data.productId, {
        type: "position_opened",
        data,
        timestamp: Date.now(),
    });
}

/**
 * Broadcast when a position is closed
 */
export function broadcastPositionClosed(data: {
    owner: string;
    productId: number;
    side: "long" | "short";
    size: number;
    pnl: number;
    exitPrice: number;
}): void {
    broadcastToProduct(data.productId, {
        type: "position_closed",
        data,
        timestamp: Date.now(),
    });
}

/**
 * Broadcast when a new market is created (global event)
 */
export function broadcastMarketCreated(data: {
    productId: number;
    creator: string;
}): void {
    broadcast({
        type: "market_created",
        data,
        timestamp: Date.now(),
    });
}

/**
 * Broadcast market stats update
 */
export function broadcastMarketStats(data: {
    productId: number;
    longOpenInterest: number;
    shortOpenInterest: number;
    totalOpenInterest: number;
}): void {
    broadcastToProduct(data.productId, {
        type: "market_stats",
        data,
        timestamp: Date.now(),
    });
}

/**
 * Broadcast account update
 */
export function broadcastAccountUpdate(data: {
    owner: string;
    balance: number;
    positionCount: number;
}): void {
    broadcastToAccount(data.owner, {
        type: "account_update",
        data,
        timestamp: Date.now(),
    });
}

// ── WebSocket Route ──────────────────────────────────────────────────────────

export const wsRoutes = new Elysia({ prefix: "/ws" })
    .ws("/trading", {
        open(ws) {
            const ip = (ws as any).remoteAddress || "127.0.0.1";
            
            // Check if we can accept this connection
            const check = registry.canAcceptConnection(ip);
            if (!check.ok) {
                logger.warn(`Rejecting connection from ${ip}: ${check.reason}`);
                // Send error message before closing
                try {
                    ws.send(JSON.stringify({
                        type: "error",
                        data: { message: check.reason },
                        timestamp: Date.now(),
                    }));
                } catch { /* ignore */ }
                ws.close(1008, check.reason);
                return;
            }

            const now = Date.now();
            const clientId = registry.generateId();
            
            const client: WsClient = {
                id: clientId,
                ws,
                ip,
                subscribedProducts: new Set(),
                subscribedAccounts: new Set(),
                lastPing: 0,
                lastPong: now,
                isAlive: true,
                connectedAt: now,
            };

            // Store client ID on ws object for close handler
            (ws as any)._clientId = clientId;
            (ws as any)._registered = true;

            registry.register(client);

            // Send welcome message
            ws.send(JSON.stringify({
                type: "connected",
                data: { 
                    clientId, 
                    clientCount: registry.size,
                    heartbeatInterval: HEARTBEAT_INTERVAL,
                },
                timestamp: now,
            }));
        },

        message(ws, rawMessage) {
            const clientId = (ws as any)._clientId;
            if (!clientId) return;

            const client = registry.get(clientId);
            if (!client) return;

            // Any message received = client is alive
            registry.markAlive(clientId);

            // Parse message
            let message: any;
            try {
                message = typeof rawMessage === "string" 
                    ? JSON.parse(rawMessage) 
                    : rawMessage;
            } catch (e) {
                logger.warn(`Invalid message from ${clientId}`);
                return;
            }

            const msgType = message?.type;

            // Handle pong (response to server_ping)
            if (msgType === "pong" || msgType === "client_pong") {
                // Already marked alive above
                return;
            }

            // Handle client ping (for client-initiated keepalive)
            if (msgType === "ping") {
                try {
                    ws.send(JSON.stringify({
                        type: "pong",
                        data: { clientCount: registry.size },
                        timestamp: Date.now(),
                    }));
                } catch { /* ignore */ }
                return;
            }

            // Handle subscriptions
            if (msgType === "subscribe") {
                if (Array.isArray(message.products)) {
                    for (const pid of message.products) {
                        if (typeof pid === "number" && 
                            client.subscribedProducts.size + client.subscribedAccounts.size < MAX_SUBSCRIPTIONS_PER_CLIENT) {
                            client.subscribedProducts.add(pid);
                        }
                    }
                }
                if (Array.isArray(message.accounts)) {
                    for (const acc of message.accounts) {
                        if (typeof acc === "string" && 
                            client.subscribedProducts.size + client.subscribedAccounts.size < MAX_SUBSCRIPTIONS_PER_CLIENT) {
                            client.subscribedAccounts.add(acc);
                        }
                    }
                }

                if (client.subscribedProducts.size + client.subscribedAccounts.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
                    ws.send(JSON.stringify({
                        type: "error",
                        data: { message: `Subscription limit reached (max ${MAX_SUBSCRIPTIONS_PER_CLIENT})` },
                        timestamp: Date.now(),
                    }));
                }

                logger.debug(`Client ${clientId} subscriptions: ${client.subscribedProducts.size} products, ${client.subscribedAccounts.size} accounts`);
                return;
            }

            if (msgType === "unsubscribe") {
                if (Array.isArray(message.products)) {
                    for (const pid of message.products) {
                        client.subscribedProducts.delete(pid);
                    }
                }
                if (Array.isArray(message.accounts)) {
                    for (const acc of message.accounts) {
                        client.subscribedAccounts.delete(acc);
                    }
                }
                return;
            }
        },

        close(ws) {
            const clientId = (ws as any)._clientId;
            const wasRegistered = (ws as any)._registered;

            if (clientId && wasRegistered) {
                registry.unregister(clientId);
            }
        },
    })

    // HTTP endpoint for WS stats
    .get("/stats", () => ({
        connectedClients: registry.size,
        timestamp: Date.now(),
    }), {
        detail: {
            tags: ["System"],
            summary: "WebSocket stats",
            description: "Get current WebSocket connection count",
            hide: true,
        },
    });
