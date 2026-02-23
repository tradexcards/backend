/**
 * Types that mirror TCGPlayer's API responses.
 * These are the shapes we get back from their endpoints.
 */

// ── Card condition ──────────────────────────────────────────────────────────

export const Condition = {
    NEAR_MINT: "Near Mint",
    LIGHTLY_PLAYED: "Lightly Played",
    MODERATELY_PLAYED: "Moderately Played",
    HEAVILY_PLAYED: "Heavily Played",
    DAMAGED: "Damaged",
} as const;

export type ConditionType = (typeof Condition)[keyof typeof Condition];

// ── Marketplace ─────────────────────────────────────────────────────────────

export interface Listing {
    listing_id: string;
    seller_name: string;
    condition: string;
    price: number;
    quantity: number;
    shipping_price: number;
    printing: string;
    language: string;
    seller_rating: number | null;
    seller_sales: string | null;
    gold_seller: boolean;
    verified_seller: boolean;
}

export interface Sale {
    sale_id: string;
    condition: string;
    variant: string;
    price: number;
    shipping_price: number;
    quantity: number;
    order_date: string;
    language: string;
    listing_type: string;
}

// ── Product data ────────────────────────────────────────────────────────────

/** Full product details including pricing (legacy combined shape). */
export interface ProductDetails {
    product_id: number;
    product_name: string;
    market_price: number | null;
    lowest_price: number | null;
    lowest_price_with_shipping: number | null;
    median_price: number | null;
    listings: number;
    sellers: number;
    set_name: string;
    set_code: string;
    rarity_name: string;
    product_type_name: string;
    product_line_name: string;
    image_url: string;
    url: string;
    skus: Record<string, unknown>[];
}

/** Static product info — name, set, rarity, images. Rarely changes. */
export interface ProductInfo {
    product_id: number;
    product_name: string;
    set_name: string;
    set_code: string;
    rarity_name: string;
    product_type_name: string;
    product_line_name: string;
    image_url: string;
    url: string;
    skus: Record<string, unknown>[];
}

/** Dynamic pricing — market price, listings count. Changes every few minutes. */
export interface ProductPricing {
    product_id: number;
    market_price: number | null;
    lowest_price: number | null;
    lowest_price_with_shipping: number | null;
    median_price: number | null;
    listings: number;
    sellers: number;
    fetched_at: string;
}

// ── Price history ───────────────────────────────────────────────────────────

export interface PriceHistoryBucket {
    bucket_start_date: string;
    market_price: number;
    quantity_sold: number;
    transaction_count: number;
    low_sale_price: number | null;
    high_sale_price: number | null;
}

export interface SkuHistory {
    sku_id: string;
    condition: string;
    variant: string;
    language: string;
    total_quantity_sold: number;
    total_transaction_count: number;
    average_daily_quantity_sold: number;
    buckets: PriceHistoryBucket[];
}

export interface PriceHistory {
    product_id: number;
    range_type: string;
    skus: SkuHistory[];
    /** Flattened date strings for charting. */
    dates: string[];
    /** Flattened prices (close/market price) for charting. */
    prices: number[];
    /** Flattened low prices for OHLC charting. Null if no sales that day. */
    lows: (number | null)[];
    /** Flattened high prices for OHLC charting. Null if no sales that day. */
    highs: (number | null)[];
}
