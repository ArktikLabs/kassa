import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { STAFF_SESSION_COOKIE, verifySessionCookie } from "../src/auth/staff-session.js";
import { InMemoryStaffRepository } from "../src/services/staff/index.js";

const COOKIE_SECRET = "test-cookie-secret-must-be-at-least-32-chars-long";

const STAFF_USER_ID = "01890abc-1234-7def-8000-000000000020";
const MERCHANT_ID = "01890abc-1234-7def-8000-000000000010";
const EMAIL = "owner@warungbutini.id";
const PASSWORD = "correct-horse-battery-staple";
const DISPLAY_NAME = "Bu Tini";

const BACK_OFFICE_ORIGIN = "https://kassa-back-office.pages.dev";
const PREVIEW_ORIGIN = "https://pr-42.kassa-back-office.pages.dev";

interface Harness {
  app: FastifyInstance;
  staff: InMemoryStaffRepository;
  now: { value: Date };
}

async function setup(opts: { withCors?: boolean } = {}): Promise<Harness> {
  const passwordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const staff = new InMemoryStaffRepository();
  staff.seedStaff({
    id: STAFF_USER_ID,
    merchantId: MERCHANT_ID,
    email: EMAIL,
    passwordHash,
    displayName: DISPLAY_NAME,
    role: "owner",
  });
  const now = { value: new Date("2026-05-03T12:00:00Z") };
  const app = await buildApp({
    staffSession: {
      repository: staff,
      cookieSecret: COOKIE_SECRET,
      rateLimitPerMinute: 3,
      now: () => now.value,
      // app.inject runs against an in-memory transport without TLS, so
      // dropping `Secure` is the only way the cookie can round-trip in tests.
      cookieOptions: { secure: false },
    },
    ...(opts.withCors
      ? {
          cors: {
            allowedOrigins: [
              BACK_OFFICE_ORIGIN,
              /^https:\/\/pr-\d+\.kassa-back-office\.pages\.dev$/,
            ],
          },
        }
      : {}),
  });
  await app.ready();
  return { app, staff, now };
}

async function loginAttempt(
  app: FastifyInstance,
  body: object,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/session/login",
    headers: { "content-type": "application/json", ...headers },
    payload: body,
  });
}

describe("POST /v1/auth/session/login", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("returns the staff identity and sets the signed session cookie on a correct password", async () => {
    const res = await loginAttempt(h.app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      email: string;
      displayName: string;
      role: string;
      merchantId: string;
      issuedAt: string;
    };
    expect(body).toEqual({
      email: EMAIL,
      displayName: DISPLAY_NAME,
      role: "owner",
      merchantId: MERCHANT_ID,
      issuedAt: h.now.value.toISOString(),
    });
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieLine = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string);
    expect(cookieLine).toMatch(new RegExp(`^${STAFF_SESSION_COOKIE}=`));
    expect(cookieLine).toMatch(/HttpOnly/i);
    expect(cookieLine).toMatch(/SameSite=Lax/i);
    // 30 days in seconds, give or take rounding.
    expect(cookieLine).toMatch(/Max-Age=2592\d{3}/);
    const value = cookieLine.split(";")[0]!.split("=", 2)[1]!;
    const verified = verifySessionCookie(decodeURIComponent(value), COOKIE_SECRET, h.now.value);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.userId).toBe(STAFF_USER_ID);
      expect(verified.payload.merchantId).toBe(MERCHANT_ID);
      expect(verified.payload.email).toBe(EMAIL);
      expect(verified.payload.role).toBe("owner");
      expect(verified.payload.exp - verified.payload.iat).toBe(30 * 24 * 60 * 60 * 1000);
    }
  });

  it("normalizes the request email to lowercase before lookup", async () => {
    const res = await loginAttempt(h.app, { email: EMAIL.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong password with 401 invalid_credentials and no Set-Cookie", async () => {
    const res = await loginAttempt(h.app, { email: EMAIL, password: "nope" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_credentials");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("returns the same 401 for an unknown email so attackers can't enumerate accounts", async () => {
    const res = await loginAttempt(h.app, { email: "ghost@example.com", password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_credentials");
  });

  it("returns 422 validation_error on a malformed email", async () => {
    const res = await loginAttempt(h.app, { email: "not-an-email", password: PASSWORD });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("rate-limits per IP after the configured cap and returns 429 with no Set-Cookie", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < 3; i += 1) {
      const ok = await loginAttempt(
        h.app,
        { email: EMAIL, password: "nope" },
        { "x-forwarded-for": ip },
      );
      expect(ok.statusCode).toBe(401);
    }
    const limited = await loginAttempt(
      h.app,
      { email: EMAIL, password: PASSWORD },
      { "x-forwarded-for": ip },
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["set-cookie"]).toBeUndefined();
  });

  it("returns 503 not_configured when the route was wired without a staff repository", async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/session/login",
        headers: { "content-type": "application/json" },
        payload: { email: EMAIL, password: PASSWORD },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe("not_configured");
    } finally {
      await app.close();
    }
  });
});

describe("CORS for the back-office login flow", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup({ withCors: true });
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("returns Access-Control-Allow-Credentials and the matching origin on the preflight", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/auth/session/login",
      headers: {
        origin: BACK_OFFICE_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(BACK_OFFICE_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("matches Cloudflare Pages preview deploys via the pr-N pattern", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/auth/session/login",
      headers: {
        origin: PREVIEW_ORIGIN,
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(PREVIEW_ORIGIN);
  });

  it("does not echo Access-Control-Allow-Origin for foreign origins", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/auth/session/login",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
      },
    });
    // @fastify/cors returns 204 for any preflight but omits the
    // allow-origin header on rejected origins, which is what blocks
    // the browser client-side.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
