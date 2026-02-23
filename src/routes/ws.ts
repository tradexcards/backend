/**
 * WebSocket Routes for Real-Time Updates
 * 
 * Provides real-time updates to all connected clients for:
 * - Price updates (from pricing loop)
 * - Trading events (positions opened/closed, markets created)
 * - Market stats changes (open interest updates)
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
    ws: any;
    subscribedProducts: Set<number>;
    subscribedAccounts: Set<string>;
}

// ── Client Management ────────────────────────────────────────────────────────

const clients = new Map<string, WsClient>();
let clientIdCounter = 0;

// Limits to prevent memory exhaustion
const MAX_CLIENTS = 1000;
const MAX_CLIENTS_PER_IP = 25; // L-6: Per-IP connection limit (generous for dev)
const MAX_SUBSCRIPTIONS_PER_CLIENT = 500; // Max products + accounts per client
const CLIENT_CLEANUP_INTERVAL = 60_000; // 1 minute
const CLIENT_STALE_TIMEOUT = 5 * 60_000; // 5 minutes without activity

/** L-6: Track connections per IP for rate limiting */
const ipConnectionCounts = new Map<string, number>();

function generateClientId(): string {
    return `client_${++clientIdCounter}_${Date.now()}`;
}

export function getClientCount(): number {
    return clients.size;
}

/**
 * Periodic cleanup of stale clients that may not have disconnected cleanly.
 * Runs every minute and removes clients that haven't had activity in 5 minutes.
 */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startClientCleanup(): void {
    if (cleanupTimer) return;
    
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        let removed = 0;
        
        for (const [clientId, client] of clients) {
            const lastActivity = (client as any).lastActivity || 0;
            if (now - lastActivity > CLIENT_STALE_TIMEOUT) {
                try {
                    client.ws.close();
                } catch { /* ignore */ }
                clients.delete(clientId);
                removed++;
            }
        }
        
        if (removed > 0) {
            logger.info(`Cleaned up ${removed} stale clients (remaining: ${clients.size})`);
        }
    }, CLIENT_CLEANUP_INTERVAL);
}

// Start cleanup on module load
startClientCleanup();

/** Stop the client cleanup timer (for graceful shutdown) */
export function stopClientCleanup(): void {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

// ── Broadcasting ─────────────────────────────────────────────────────────────

/**
 * Broadcast a message to all connected clients (unfiltered).
 * Prefer the targeted broadcast helpers below for product/account-specific messages.
 */
export function broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;
    
    for (const [clientId, client] of clients) {
        try {
            client.ws.send(payload);
            sent++;
        } catch (e) {
            logger.warn(`Failed to send to ${clientId}, removing client`);
            clients.delete(clientId);
        }
    }
    
    if (sent > 0) {
        logger.debug(`Broadcast ${message.type} to ${sent} clients`);
    }
}

/**
 * Send a message only to clients that are subscribed to a specific product.
 * Falls back to all clients if no subscriptions are set (empty subscribedProducts = "subscribe to all").
 */
function broadcastToProduct(productId: number, message: WsMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;
    
    for (const [clientId, client] of clients) {
        // If client has no product subscriptions, treat as "subscribed to all" (backward compat)
        if (client.subscribedProducts.size > 0 && !client.subscribedProducts.has(productId)) {
            continue;
        }
        try {
            client.ws.send(payload);
            sent++;
        } catch (e) {
            logger.warn(`Failed to send to ${clientId}, removing client`);
            clients.delete(clientId);
        }
    }
    
    if (sent > 0) {
        logger.debug(`Broadcast ${message.type} (product=${productId}) to ${sent} clients`);
    }
}

/**
 * Send a message only to clients subscribed to a specific account (wallet).
 * Falls back to all clients if no account subscriptions are set.
 */
function broadcastToAccount(owner: string, message: WsMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;
    
    for (const [clientId, client] of clients) {
        // If client has no account subscriptions, treat as "subscribed to all" (backward compat)
        if (client.subscribedAccounts.size > 0 && !client.subscribedAccounts.has(owner)) {
            continue;
        }
        try {
            client.ws.send(payload);
            sent++;
        } catch (e) {
            logger.warn(`Failed to send to ${clientId}, removing client`);
            clients.delete(clientId);
        }
    }
    
    if (sent > 0) {
        logger.debug(`Broadcast ${message.type} (account=${owner.slice(0,8)}...) to ${sent} clients`);
    }
}

/**
 * Broadcast price updates — filtered by product subscription.
 * Each client only receives prices for products they subscribed to.
 */
export function broadcastPriceUpdate(prices: Array<{ productId: number; price: number; source: string }>): void {
    if (prices.length === 0) return;
    
    // For efficiency, send all prices at once to clients that have no filter,
    // and per-product to clients with subscriptions.
    const allPricesMsg: WsMessage = {
        type: "price_update",
        data: { prices },
        timestamp: Date.now(),
    };
    
    for (const [clientId, client] of clients) {
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
            logger.warn(`Failed to send to ${clientId}, removing client`);
            clients.delete(clientId);
        }
    }
}

/**
 * Broadcast when a position is opened — filtered by product + account
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
 * Broadcast when a position is closed — filtered by product
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
 * Broadcast when a new market is created — sent to all (global event)
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
 * Broadcast market stats update — filtered by product
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
 * Broadcast account update — filtered by account subscription
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
        // No body validation - handle any JSON message
        open(ws) {
            // Enforce max client limit
            if (clients.size >= MAX_CLIENTS) {
                logger.warn(`Max clients reached (${MAX_CLIENTS}), rejecting connection`);
                (ws as any)._rejected = true; // Mark so close() skips decrement
                ws.close(1013, "Server is at capacity");
                return;
            }

            // L-6: Per-IP connection limit
            const ip = (ws as any).remoteAddress || "unknown";
            const currentCount = ipConnectionCounts.get(ip) || 0;
            if (currentCount >= MAX_CLIENTS_PER_IP) {
                logger.warn(`Per-IP limit reached for ${ip} (${MAX_CLIENTS_PER_IP}), rejecting`);
                (ws as any)._rejected = true; // Mark so close() skips decrement
                ws.close(1008, "Too many connections from your IP");
                return;
            }
            ipConnectionCounts.set(ip, currentCount + 1);
            
            const clientId = generateClientId();
            const client: WsClient = {
                ws,
                subscribedProducts: new Set(),
                subscribedAccounts: new Set(),
            };
            // Track last activity for stale client cleanup
            (client as any).lastActivity = Date.now();
            (client as any).ip = ip;
            clients.set(clientId, client);
            
            // Store clientId on ws for later retrieval
            (ws as any).clientId = clientId;
            
            logger.info(`Client connected: ${clientId} (total: ${getClientCount()})`);
            
            // Send welcome message
            ws.send(JSON.stringify({
                type: "connected",
                data: { clientId, clientCount: getClientCount() },
                timestamp: Date.now(),
            }));
        },
        
        message(ws, rawMessage) {
            const clientId = (ws as any).clientId;
            const client = clients.get(clientId);
            if (!client) return;
            
            // Update last activity timestamp
            (client as any).lastActivity = Date.now();
            
            // Parse message - could be string or already parsed
            let message: any;
            try {
                message = typeof rawMessage === "string" 
                    ? JSON.parse(rawMessage) 
                    : rawMessage;
            } catch (e) {
                logger.warn(`Invalid message from ${clientId}: ${rawMessage}`);
                return;
            }
            
            const msgType = message?.type;
            
            // Handle subscription messages
            if (msgType === "subscribe") {
                const totalSubs = client.subscribedProducts.size + client.subscribedAccounts.size;
                
                if (Array.isArray(message.products)) {
                    for (const pid of message.products) {
                        if (typeof pid === "number" && client.subscribedProducts.size + client.subscribedAccounts.size < MAX_SUBSCRIPTIONS_PER_CLIENT) {
                            client.subscribedProducts.add(pid);
                        }
                    }
                }
                if (Array.isArray(message.accounts)) {
                    for (const acc of message.accounts) {
                        if (typeof acc === "string" && client.subscribedProducts.size + client.subscribedAccounts.size < MAX_SUBSCRIPTIONS_PER_CLIENT) {
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
                
                logger.debug(`Client ${clientId} subscribed to ${client.subscribedProducts.size} products, ${client.subscribedAccounts.size} accounts`);
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
            }
            
            // Handle ping
            if (msgType === "ping") {
                ws.send(JSON.stringify({
                    type: "pong",
                    data: { clientCount: getClientCount() },
                    timestamp: Date.now(),
                }));
            }
        },
        
        close(ws) {
            // If the connection was rejected in open(), don't try to clean up
            if ((ws as any)._rejected) return;
            
            const clientId = (ws as any).clientId;
            if (clientId) {
                // L-6: Decrement per-IP counter
                const client = clients.get(clientId);
                if (client) {
                    const ip = (client as any).ip;
                    if (ip) {
                        const count = ipConnectionCounts.get(ip) || 1;
                        if (count <= 1) {
                            ipConnectionCounts.delete(ip);
                        } else {
                            ipConnectionCounts.set(ip, count - 1);
                        }
                    }
                }
                clients.delete(clientId);
                logger.info(`Client disconnected: ${clientId} (remaining: ${getClientCount()})`);
            } else {
                // Connection closed before open completed - nothing to clean up
                logger.debug(`Client disconnected before registration (remaining: ${getClientCount()})`);
            }
        },
    })
    
    // HTTP endpoint to check WS stats
    .get("/stats", () => {
        return {
            connectedClients: getClientCount(),
            timestamp: Date.now(),
        };
    }, {
        detail: {
            tags: ["System"],
            summary: "WebSocket stats",
            description: "Get current WebSocket connection count",
            hide: true,
        },
    });
