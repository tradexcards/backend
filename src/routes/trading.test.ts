/**
 * Trading Routes Tests
 *
 * Tests for the /api/trading endpoints.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../app";

describe("Trading Routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    app.stop();
  });

  describe("GET /api/trading/exchange", () => {
    test("returns exchange state or 503 if not initialized", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/exchange")
      );

      // May return 200 (initialized) or 503 (not initialized) depending on state
      expect([200, 503]).toContain(response.status);

      if (response.status === 200) {
        const data = await response.json();
        expect(data).toHaveProperty("admin");
        expect(data).toHaveProperty("paused");
        expect(data).toHaveProperty("marketCount");
      } else {
        const data = await response.json();
        expect(data).toHaveProperty("error");
      }
    });
  });

  describe("GET /api/trading/market/:productId", () => {
    test("returns 400 for invalid product ID", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/market/invalid")
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid product ID");
    });

    test("returns 404 for non-existent market", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/market/999999999")
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Market not found");
    });
  });

  describe("GET /api/trading/oracle/prices", () => {
    test("returns oracle prices", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/oracle/prices")
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("prices");
      expect(Array.isArray(data.prices)).toBe(true);
    });
  });

  describe("GET /api/trading/products/tradable", () => {
    test("returns tradable products list", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/products/tradable")
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("products");
      expect(Array.isArray(data.products)).toBe(true);
    });
  });

  describe("POST /api/trading/sign-price", () => {
    test("returns 400 for invalid product_id", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/sign-price", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: "invalid" }),
        })
      );

      expect(response.status).toBe(400);
    });

    test("returns 400 for missing product_id", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/sign-price", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      );

      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/trading/user/:wallet", () => {
    test("returns 400 for invalid wallet address", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/trading/user/invalid-wallet")
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("Invalid");
    });

    test("returns user data for valid wallet format", async () => {
      // Use a valid base58 pubkey format (even if account doesn't exist)
      const response = await app.handle(
        new Request("http://localhost/api/trading/user/11111111111111111111111111111111")
      );

      // Should be 200 (with null account) or 404
      expect([200, 404]).toContain(response.status);
    });
  });
});
