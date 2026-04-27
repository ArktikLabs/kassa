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
      expect(enrol?.summary).toBeTruthy();

      const codes = spec.paths["/v1/auth/enrolment-codes"]?.post;
      expect(codes).toBeDefined();
      expect(codes?.tags).toContain("auth");
      expect(codes?.summary).toBeTruthy();
    });

    it("documents the auth placeholder routes still pending real handlers", () => {
      // These remain `notImplemented` placeholders even after the catalog /
      // outlets / sales / stock / eod / payments routes were re-decorated
      // (KASA-125). They keep their schema annotations so OpenAPI shows them
      // as reserved endpoints.
      const placeholders: Array<[string, "get" | "post"]> = [
        ["/v1/auth/heartbeat", "post"],
        ["/v1/auth/pin/verify", "post"],
        ["/v1/auth/session/login", "post"],
        ["/v1/auth/session/logout", "post"],
      ];
      for (const [path, method] of placeholders) {
        const op = spec.paths[path]?.[method];
        expect(op, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
        expect(op?.summary, `${method.toUpperCase()} ${path} missing summary`).toBeTruthy();
      }
    });

    it("documents the evolved data-plane routes (KASA-125)", () => {
      // Each entry: [path, method, expected tag]. These are the routes that
      // had real handlers but no `schema:` annotation prior to KASA-125.
      const decorated: Array<[string, "get" | "post" | "patch" | "delete", string]> = [
        ["/v1/catalog/items", "get", "catalog"],
        ["/v1/catalog/items", "post", "catalog"],
        ["/v1/catalog/items/{itemId}", "get", "catalog"],
        ["/v1/catalog/items/{itemId}", "patch", "catalog"],
        ["/v1/catalog/items/{itemId}", "delete", "catalog"],
        ["/v1/catalog/boms", "get", "catalog"],
        ["/v1/catalog/uoms", "get", "catalog"],
        ["/v1/outlets/", "get", "outlets"],
        ["/v1/sales/submit", "post", "sales"],
        ["/v1/sales/{saleId}", "get", "sales"],
        ["/v1/sales/{saleId}/void", "post", "sales"],
        ["/v1/sales/{saleId}/refund", "post", "sales"],
        ["/v1/sales/", "get", "sales"],
        ["/v1/stock/snapshot", "get", "stock"],
        ["/v1/stock/ledger", "get", "stock"],
        ["/v1/eod/close", "post", "eod"],
        ["/v1/payments/qris", "post", "payments"],
        ["/v1/payments/qris/{orderId}/status", "get", "payments"],
        ["/v1/payments/webhooks/midtrans", "post", "payments"],
        ["/v1/admin/reconciliation/run", "post", "reconciliation"],
        ["/v1/admin/reconciliation/match", "post", "reconciliation"],
      ];
      for (const [path, method, tag] of decorated) {
        const op = spec.paths[path]?.[method];
        expect(op, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
        expect(op?.tags, `${method.toUpperCase()} ${path} missing tag '${tag}'`).toContain(tag);
        expect(op?.summary, `${method.toUpperCase()} ${path} missing summary`).toBeTruthy();
      }
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
});
