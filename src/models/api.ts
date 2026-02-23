/**
 * API response shapes.
 * These define the JSON bodies our routes return.
 */

import type { ProductDetails, Listing, Sale, PriceHistory } from "./tcgplayer";
import type { CardAnalysis, AnalysisSummary } from "./analysis";

// ── System ──────────────────────────────────────────────────────────────────

export interface HealthResponse {
    status: string;
    version: string;
    timestamp: string;
}

// ── Cards ───────────────────────────────────────────────────────────────────

export interface CardsOverviewResponse {
    metadata: AnalysisSummary;
    top_tradable: CardAnalysis[];
}

export interface CardDetailResponse {
    product: ProductDetails;
    listings: Listing[];
    recent_sales: Sale[];
    price_history: PriceHistory | null;
    analysis: CardAnalysis | null;
}

export interface CardBundleResponse {
    product: ProductDetails;
    listings: Listing[];
    recent_sales: Sale[];
    price_history: {
        month: PriceHistory | null;
        annual: PriceHistory | null;
    };
    analysis: CardAnalysis | null;
}

export interface CardProductResponse {
    product: ProductDetails;
    analysis: CardAnalysis | null;
}

export interface CardListingsResponse {
    product_id: number;
    listings: Listing[];
    count: number;
}

export interface CardSalesResponse {
    product_id: number;
    recent_sales: Sale[];
    count: number;
}

export interface CardHistoryResponse {
    product_id: number;
    price_history: PriceHistory | null;
}

export interface CardSearchResponse {
    query: string;
    results: CardAnalysis[];
    count: number;
}

export interface CardListResponse {
    cards: CardAnalysis[];
    count: number;
    page: number;
    per_page: number;
}
