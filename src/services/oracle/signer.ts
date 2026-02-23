/**
 * PriceOracle — Ed25519 signing for on-chain price verification.
 *
 * Message format (20 bytes, little-endian):
 *   product_id:  u32  (4 bytes)
 *   price:       u64  (8 bytes, scaled 1e8 — e.g. $10.50 = 1_050_000_000)
 *   timestamp:   i64  (8 bytes, unix seconds)
 *
 * The user's trade transaction includes:
 *   1. Ed25519SigVerify precompile instruction (verifies the signature)
 *   2. The trade instruction with price + timestamp in instruction data
 *
 * The on-chain program reads the Instructions sysvar to confirm the Ed25519
 * verification passed, then uses the price.
 */
import { Keypair } from "@solana/web3.js";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// noble/ed25519 v3 requires setting the sha512 sync hash
ed.hashes.sha512 = (...msgs: Uint8Array[]) => {
    const h = sha512.create();
    for (const m of msgs) h.update(m);
    return h.digest();
};

export interface SignedPrice {
    productId: number;
    price: bigint;          // scaled 1e8
    timestamp: number;      // unix seconds
    signature: Uint8Array;  // 64 bytes
    publicKey: Uint8Array;  // 32 bytes
    message: Uint8Array;    // 20 bytes (the signed message)
}

/**
 * Build the 20-byte signed price message.
 */
export function buildPriceMessage(productId: number, price: bigint, timestamp: number): Uint8Array {
    const buf = new ArrayBuffer(20);
    const view = new DataView(buf);
    view.setUint32(0, productId, true);         // u32 LE
    view.setBigUint64(4, price, true);           // u64 LE
    view.setBigInt64(12, BigInt(timestamp), true); // i64 LE
    return new Uint8Array(buf);
}

export class PriceOracle {
    private secretKey: Uint8Array; // 32-byte Ed25519 private key
    private pubkey: Uint8Array;    // 32-byte Ed25519 public key
    private pubkeyBase58: string;

    constructor(keypair: Keypair) {
        // Solana Keypair.secretKey is 64 bytes: [32-byte privkey][32-byte pubkey]
        this.secretKey = keypair.secretKey.slice(0, 32);
        this.pubkey = keypair.publicKey.toBytes();
        this.pubkeyBase58 = keypair.publicKey.toBase58();
    }

    /**
     * Sign a price for a product. Returns everything the frontend needs to
     * build the Ed25519SigVerify instruction + trade instruction.
     */
    signPrice(productId: number, priceScaled: bigint): SignedPrice {
        const timestamp = Math.floor(Date.now() / 1000);
        const message = buildPriceMessage(productId, priceScaled, timestamp);
        const signature = ed.sign(message, this.secretKey);

        return {
            productId,
            price: priceScaled,
            timestamp,
            signature,
            publicKey: this.pubkey,
            message,
        };
    }

    /** Oracle's public key bytes. */
    getPublicKeyBytes(): Uint8Array {
        return this.pubkey;
    }

    /** Oracle's public key (base58). */
    getPublicKey(): string {
        return this.pubkeyBase58;
    }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: PriceOracle | null = null;

export function initOracleSigner(keypair: Keypair): PriceOracle {
    _instance = new PriceOracle(keypair);
    return _instance;
}

export function oracleSigner(): PriceOracle {
    if (!_instance) throw new Error("PriceOracle not initialized");
    return _instance;
}
