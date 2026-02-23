/**
 * Shared crypto utilities.
 *
 * Provides timing-safe string comparison for admin password checks.
 */

import { createHmac } from "crypto";
import { timingSafeEqual as nodeTimingSafeEqual } from "crypto";

/**
 * Timing-safe string comparison that does NOT leak the password length.
 *
 * Both inputs are HMAC-SHA256'd with a fixed key before comparison,
 * so the comparison is always on 32-byte digests regardless of input lengths.
 * This prevents length-based timing side channels.
 */
export function timingSafeEqual(a: string, b: string): boolean {
    // HMAC both inputs to fixed-length digests — hides length information
    const key = "tcgp-perp-dex-timing-safe";
    const digestA = createHmac("sha256", key).update(a).digest();
    const digestB = createHmac("sha256", key).update(b).digest();

    // Constant-time comparison of fixed-length buffers
    return nodeTimingSafeEqual(digestA, digestB);
}
