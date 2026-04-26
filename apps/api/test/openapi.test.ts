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
      // These four are the only routes that remain `notImplemented` after main
      // landed real handlers for catalog / outlets / sales / stock / eod /
      // payments. They keep their schema annotations so OpenAPI shows them as
      // reserved endpoints. Re-decorating the now-implemented routes with
      // schemas is tracked as a follow-up.
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
