import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { collectStartupWarnings, loadEnv } from "../src/config.js";

/**
 * KASA-203: missing `SESSION_COOKIE_SECRET` in production must NOT crash boot.
 * Instead the env loader returns cleanly, `collectStartupWarnings()` reports
 * a structured `missing_session_cookie_secret` entry, the login route still
 * 503s, and `/health` exposes the warning code so monitoring sees the
 * degradation without paging on-call.
 *
 * KASA-201 incident: the pre-KASA-203 `superRefine` threw on a missing secret
 * and took kassa-api-staging fully offline (every route, including /health)
 * for a config gap that only affects /v1/auth/session/login.
 */

const REQUIRED_PROD_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://kassa:kassa@localhost:5432/kassa",
} as const;

describe("loadEnv()", () => {
  it("does NOT throw when SESSION_COOKIE_SECRET is missing in production", () => {
    expect(() => loadEnv({ ...REQUIRED_PROD_ENV })).not.toThrow();
  });

  it("still throws when DATABASE_URL is missing in production (no /v1 route can serve without it)", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL is required/);
  });

  it("accepts a valid SESSION_COOKIE_SECRET (>=32 chars) and surfaces no warnings", () => {
    const env = loadEnv({
      ...REQUIRED_PROD_ENV,
      SESSION_COOKIE_SECRET: "x".repeat(32),
    });
    expect(env.SESSION_COOKIE_SECRET).toHaveLength(32);
    expect(collectStartupWarnings(env)).toEqual([]);
  });

  it("rejects a too-short SESSION_COOKIE_SECRET (shape validation is unchanged)", () => {
    expect(() =>
      loadEnv({
        ...REQUIRED_PROD_ENV,
        SESSION_COOKIE_SECRET: "too-short",
      }),
    ).toThrow();
  });
});

describe("collectStartupWarnings()", () => {
  it("returns a missing_session_cookie_secret warning when the secret is unset in production", () => {
    const env = loadEnv({ ...REQUIRED_PROD_ENV });
    const warnings = collectStartupWarnings(env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("missing_session_cookie_secret");
    expect(warnings[0]?.message).toContain("SESSION_COOKIE_SECRET");
    expect(warnings[0]?.message).toContain("503");
  });

  it("returns no warnings when the secret is configured in production", () => {
    const env = loadEnv({
      ...REQUIRED_PROD_ENV,
      SESSION_COOKIE_SECRET: "x".repeat(32),
    });
    expect(collectStartupWarnings(env)).toEqual([]);
  });

  it("does not warn when SESSION_COOKIE_SECRET is unset in development", () => {
    const env = loadEnv({ NODE_ENV: "development" });
    expect(collectStartupWarnings(env)).toEqual([]);
  });

  it("does not warn when SESSION_COOKIE_SECRET is unset in test", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(collectStartupWarnings(env)).toEqual([]);
  });
});

describe("GET /health surfaces structured startup warnings", () => {
  it("returns warnings:[] on a cleanly configured boot", async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; warnings: string[] };
      expect(body.status).toBe("ok");
      expect(body.warnings).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("exposes the warning code when SESSION_COOKIE_SECRET is missing in production", async () => {
    const env = loadEnv({ ...REQUIRED_PROD_ENV });
    const startupWarnings = collectStartupWarnings(env);
    const app = await buildApp({ startupWarnings });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; warnings: string[] };
      expect(body.status).toBe("ok");
      expect(body.warnings).toContain("missing_session_cookie_secret");
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/auth/session/login still 503s when the secret is absent", () => {
  it("returns 503 not_configured (no buildApp.staffSession wired)", async () => {
    const env = loadEnv({ ...REQUIRED_PROD_ENV });
    const startupWarnings = collectStartupWarnings(env);
    expect(startupWarnings).toHaveLength(1);

    const app = await buildApp({ startupWarnings });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/session/login",
        headers: { "content-type": "application/json" },
        payload: { email: "owner@kassa.id", password: "correct-horse-battery-staple" },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe("not_configured");
    } finally {
      await app.close();
    }
  });
});
