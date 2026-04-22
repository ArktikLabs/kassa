import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

describe("api scaffold", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /v1/health", () => {
    it("returns 200 with a health payload", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        status: string;
        service: string;
        version: string;
        uptimeSeconds: number;
        timestamp: string;
      };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("kassa-api");
      expect(typeof body.version).toBe("string");
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
    });
  });

  describe("placeholder endpoints return 501", () => {
    const placeholders: ReadonlyArray<{ method: "GET" | "POST"; url: string }> = [
      { method: "POST", url: "/v1/auth/enroll" },
      { method: "POST", url: "/v1/auth/heartbeat" },
      { method: "POST", url: "/v1/auth/session/login" },
      { method: "GET", url: "/v1/catalog/items" },
      { method: "GET", url: "/v1/catalog/boms" },
      { method: "GET", url: "/v1/catalog/uoms" },
      { method: "GET", url: "/v1/outlets" },
      { method: "GET", url: "/v1/stock/snapshot" },
      { method: "POST", url: "/v1/sales" },
      { method: "POST", url: "/v1/sales/sync" },
      { method: "POST", url: "/v1/payments/qris" },
      { method: "POST", url: "/v1/payments/webhooks/midtrans" },
      { method: "POST", url: "/v1/eod/close" },
      { method: "GET", url: "/v1/eod/report" },
    ];

    it.each(placeholders)("$method $url -> 501 not_implemented", async ({ method, url }) => {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(501);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_implemented");
      expect(body.error.message).toContain(url);
    });
  });

  describe("unknown routes", () => {
    it("returns 404 in the shared error shape", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_found");
    });
  });
});
