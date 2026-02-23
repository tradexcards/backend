/**
 * Color-coded logging utility.
 *
 * Each tag gets a consistent ANSI color. Usage:
 *
 *   import { log } from "../log";
 *   const L = log("keeper");
 *   L.info("Initialized");          // \x1b[36m[keeper]\x1b[0m Initialized
 *   L.error("Something broke");     // \x1b[31m[keeper]\x1b[0m Something broke
 *   L.warn("Heads up");             // \x1b[33m[keeper]\x1b[0m Heads up
 */

// ── ANSI colors ─────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const COLORS: Record<string, string> = {
    // Fixed assignments for known tags
    boot:       "\x1b[35m",   // magenta
    fatal:      "\x1b[41m\x1b[37m", // white on red bg
    keeper:     "\x1b[36m",   // cyan
    pricing:    "\x1b[32m",   // green
    prefetch:   "\x1b[34m",   // blue
    sync:       "\x1b[33m",   // yellow
    tcgplayer:  "\x1b[38;5;208m", // orange
    tcgcsv:     "\x1b[38;5;147m", // light purple
    analyzer:   "\x1b[38;5;214m", // gold
    env:        "\x1b[90m",   // gray
    cache:      "\x1b[90m",   // gray
};

// Fallback palette for dynamic / unknown tags
const FALLBACK_PALETTE = [
    "\x1b[36m", "\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m",
    "\x1b[38;5;208m", "\x1b[38;5;147m", "\x1b[38;5;214m",
    "\x1b[38;5;81m", "\x1b[38;5;176m",
];

function colorFor(tag: string): string {
    // Check known tags (strip dynamic suffixes like "loop:Daily Archive Sync" → "loop")
    const base = tag.includes(":") ? tag.split(":")[0] : tag;
    if (COLORS[base]) return COLORS[base];
    if (COLORS[tag]) return COLORS[tag];

    // Deterministic hash for unknown tags
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
        hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    }
    return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
}

// ── Logger factory ──────────────────────────────────────────────────────────

export interface Logger {
    /** Info-level log (console.log). */
    info: (msg: string, ...args: any[]) => void;
    /** Error-level log (console.error). */
    error: (msg: string, ...args: any[]) => void;
    /** Warning-level log (console.warn). */
    warn: (msg: string, ...args: any[]) => void;
    /** Debug-level log (console.debug) - only shown in development. */
    debug: (msg: string, ...args: any[]) => void;
}

const isDev = process.env.NODE_ENV !== "production";

export function log(tag: string): Logger {
    const color = colorFor(tag);
    const prefix = `${BOLD}${color}[${tag}]${RESET}`;

    return {
        info:  (msg, ...args) => console.log(prefix, msg, ...args),
        error: (msg, ...args) => console.error(prefix, msg, ...args),
        warn:  (msg, ...args) => console.warn(prefix, msg, ...args),
        debug: (msg, ...args) => isDev && console.debug(prefix, msg, ...args),
    };
}
