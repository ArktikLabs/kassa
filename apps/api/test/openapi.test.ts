import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

interface OpenapiSpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
  components?: { schemas?: Record<string, unknown> };
}

describe("OpenAPI / Swagger UI", () => {
  let app: FastifyInstance;
  let spec: OpenapiSpec;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    spec = res.json() as OpenapiSpec;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /docs/json", () => {
    it("serves an OpenAPI 3.x spec", async () => {
      const res = await app.inject({ method: "GET", url: "/docs/json" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      const body = res.json() as OpenapiSpec;
      expect(body.openapi).toMatch(/^3\./);
      expect(body.info.title).toBe("Kassa API");
    });

    it("includes the live health probe with its tag", () => {
      const op = spec.paths["/health"]?.get;
      expect(op).toBeDefined();
      expect(op?.tags).toContain("health");
    });

    it("documents the live device-enrolment endpoints under the /v1 prefix", () => {
      const enrol = spec.paths["/v1/auth/enroll"]?.post;
      expect(enrol).toBeDefined();
      expect(enrol?.tags).toContain("auth");

      const codes = spec.paths["/v1/auth/enrolment-codes"]?.post;
      expect(codes).toBeDefined();
      expect(codes?.tags).toContain("auth");
    });

    it("documents every placeholder route", () => {
      const placeholders: Array<[string, "get" | "post"]> = [
        ["/v1/auth/heartbeat", "post"],
        ["/v1/auth/pin/verify", "post"],
        ["/v1/auth/session/login", "post"],
        ["/v1/auth/session/logout", "post"],
        ["/v1/catalog/items", "get"],
        ["/v1/catalog/items/{itemId}", "get"],
        ["/v1/catalog/boms", "get"],
        ["/v1/catalog/uoms", "get"],
        ["/v1/catalog/modifiers", "get"],
        ["/v1/outlets/", "get"],
        ["/v1/outlets/{outletId}", "get"],
        ["/v1/stock/snapshot", "get"],
        ["/v1/stock/ledger", "get"],
        ["/v1/sales/", "post"],
        ["/v1/sales/{saleId}", "get"],
        ["/v1/sales/{saleId}/void", "post"],
        ["/v1/sales/{saleId}/refund", "post"],
        ["/v1/sales/sync", "post"],
        ["/v1/payments/qris", "post"],
        ["/v1/payments/qris/{orderId}/status", "get"],
        ["/v1/eod/close", "post"],
        ["/v1/eod/report", "get"],
        ["/v1/eod/{eodId}", "get"],
      ];
      for (const [path, method] of placeholders) {
        const op = spec.paths[path]?.[method];
        expect(op, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
        expect(op?.summary, `${method.toUpperCase()} ${path} missing summary`).toBeTruthy();
      }
    });

    it("documents the Midtrans webhook", () => {
      const op = spec.paths["/v1/payments/webhooks/midtrans"]?.post;
      expect(op).toBeDefined();
      expect(op?.tags).toContain("payments");
    });
  });

  describe("GET /docs", () => {
    it("serves the Swagger UI HTML shell", async () => {
      const res = await app.inject({ method: "GET", url: "/docs" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain("swagger-ui");
    });
  });

  describe("Zod-driven validation", () => {
    it("rejects malformed bodies on /v1/auth/enroll with the standard bad_request envelope", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/enroll",
        payload: { code: "lower", deviceFingerprint: "x" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string; message: string; details?: unknown } };
      expect(body.error.code).toBe("bad_request");
      expect(body.error.details).toBeDefined();
    });
  });
});
