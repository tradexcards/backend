/**
 * Internal types used within services (not exposed via API).
 */

/** Raw card data collected from TCGCSV archive files. */
export interface CardInfo {
    product_id: number;
    category: number;
    group: string;
    sub_type: string;
    dates: string[];
    prices: (number | null)[];
}

/** Single price data point from an archive file. */
export interface PriceData {
    product_id: number;
    market_price: number;
    sub_type: string;
}
