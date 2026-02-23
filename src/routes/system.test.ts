/**
 * System Routes Tests
 *
 * Tests for the /api/system endpoints (health checks, status).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../app";

describe("System Routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    app.stop();
  });

  test("GET /api/system/health returns 200", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/system/health")
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("status");
    expect(data.status).toBe("ok");
  });

  test("GET /api/system/status returns system status", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/system/status")
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("uptime");
    expect(data).toHaveProperty("version");
  });
});
