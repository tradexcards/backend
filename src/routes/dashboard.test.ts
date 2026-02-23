/**
 * Dashboard Routes Tests
 *
 * Tests for the /api/dashboard endpoints.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../app";

describe("Dashboard Routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    app.stop();
  });

  test("GET /api/dashboard returns 200 with overview data", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/dashboard")
    );
    
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty("overview");
    expect(data).toHaveProperty("tradable_ids");
    expect(data).toHaveProperty("system");
    expect(Array.isArray(data.tradable_ids)).toBe(true);
  });

  test("GET /api/dashboard respects limit parameter", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/dashboard?limit=10")
    );
    
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.overview.top_tradable.length).toBeLessThanOrEqual(10);
  });

  test("GET /api/dashboard/bundles returns card bundles", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/dashboard/bundles?limit=5")
    );
    
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty("bundles");
    expect(Array.isArray(data.bundles)).toBe(true);
  });

  test("GET /api/dashboard/monitor returns HTML", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/dashboard/monitor")
    );
    
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("GET /api/dashboard/monitor/data returns JSON", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/dashboard/monitor/data")
    );
    
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty("timestamp");
  });
});
