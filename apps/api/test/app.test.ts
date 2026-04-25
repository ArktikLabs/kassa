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

  describe("GET /health", () => {
    it("is reachable at the unversioned path and returns a health payload", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
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

    it("is NOT mounted under the /v1 prefix (monitor contract is version-stable)", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/health" });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    });
  });

  describe("placeholder endpoints return 501", () => {
    const placeholders: ReadonlyArray<{ method: "GET" | "POST"; url: string }> = [
      // /v1/auth/enroll and /v1/auth/enrolment-codes are now live; see enrolment.test.ts.
      // /v1/sales/submit and /v1/eod/close are now live; see eod.test.ts.
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
