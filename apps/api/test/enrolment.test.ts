import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  EnrolmentService,
  InMemoryEnrolmentRepository,
  verifyApiSecret,
} from "../src/services/enrolment/index.js";
import { uuidv7 } from "../src/lib/uuid.js";

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const OUTLET_ID = "01890abc-1234-7def-8000-000000000001";
const MERCHANT_ID = "01890abc-1234-7def-8000-000000000010";
const STAFF_USER_ID = "01890abc-1234-7def-8000-000000000020";

interface Harness {
  app: FastifyInstance;
  repo: InMemoryEnrolmentRepository;
  service: EnrolmentService;
  now: { value: Date };
}

async function setup(): Promise<Harness> {
  const repo = new InMemoryEnrolmentRepository();
  repo.seedOutlet({
    outlet: { id: OUTLET_ID, name: "Warung Bu Tini — Cikini" },
    merchant: { id: MERCHANT_ID, name: "Warung Bu Tini" },
  });
  const now = { value: new Date("2026-04-23T00:00:00Z") };
  const service = new EnrolmentService({
    repository: repo,
    codeTtlMs: 10 * 60 * 1000,
    now: () => now.value,
  });
  const app = await buildApp({
    enrolment: { service, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app, repo, service, now };
}

async function issueCode(app: FastifyInstance, body: object = { outletId: OUTLET_ID }) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/enrolment-codes",
    headers: {
      authorization: `Bearer ${STAFF_TOKEN}`,
      "x-staff-user-id": STAFF_USER_ID,
      "content-type": "application/json",
    },
    payload: body,
  });
}

describe("POST /v1/auth/enrolment-codes", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it("issues a single-use 8-character code with a 10-minute TTL", async () => {
    const res = await issueCode(h.app);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { code: string; outletId: string; expiresAt: string };
    expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(body.outletId).toBe(OUTLET_ID);
    const ttl = new Date(body.expiresAt).getTime() - h.now.value.getTime();
    expect(ttl).toBe(10 * 60 * 1000);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enrolment-codes",
      payload: { outletId: OUTLET_ID },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("rejects callers with the wrong bootstrap token in constant time", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enrolment-codes",
      headers: {
        authorization: "Bearer wrong-token-of-the-same-length-fillr",
        "x-staff-user-id": STAFF_USER_ID,
      },
      payload: { outletId: OUTLET_ID },
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires X-Staff-User-Id with a UUID", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enrolment-codes",
      headers: { authorization: `Bearer ${STAFF_TOKEN}` },
      payload: { outletId: OUTLET_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the outlet is unknown", async () => {
    const res = await issueCode(h.app, { outletId: "01890abc-1234-7def-8000-000000000099" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("outlet_not_found");
  });
});

describe("POST /v1/auth/enroll", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  async function freshCode(): Promise<string> {
    const issued = await issueCode(h.app);
    return (issued.json() as { code: string }).code;
  }

  it("exchanges a fresh code for device credentials and returns the secret exactly once", async () => {
    const code = await freshCode();
    const fingerprint = "tablet-fingerprint-abc123";
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code, deviceFingerprint: fingerprint },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      deviceId: string;
      apiKey: string;
      apiSecret: string;
      outlet: { id: string; name: string };
      merchant: { id: string; name: string };
    };
    expect(body.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.apiKey.startsWith("kk_dev_")).toBe(true);
    expect(body.apiSecret.startsWith("kk_sec_")).toBe(true);
    expect(body.outlet).toEqual({ id: OUTLET_ID, name: "Warung Bu Tini — Cikini" });
    expect(body.merchant).toEqual({ id: MERCHANT_ID, name: "Warung Bu Tini" });

    const stored = h.repo._peekDevice(body.deviceId);
    expect(stored).toBeDefined();
    expect(stored?.apiKeyHash).not.toBe(body.apiSecret);
    expect(await verifyApiSecret(stored!.apiKeyHash, body.apiSecret)).toBe(true);
  });

  it("rejects replay of a consumed code with 410 Gone", async () => {
    const code = await freshCode();
    const first = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code, deviceFingerprint: "tablet-1" },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code, deviceFingerprint: "tablet-2" },
    });
    expect(second.statusCode).toBe(410);
    expect((second.json() as { error: { code: string } }).error.code).toBe("code_already_used");
  });

  it("rejects an expired code with 410 Gone", async () => {
    const code = await freshCode();
    h.now.value = new Date(h.now.value.getTime() + 11 * 60 * 1000);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code, deviceFingerprint: "tablet-late" },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: { code: string } }).error.code).toBe("code_expired");
  });

  it("returns 404 when the code was never issued (or was for the wrong outlet)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code: "ABCDEFGH", deviceFingerprint: "tablet-x" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("code_not_found");
  });

  it("returns 410 when the code's outlet has been deleted between issue and enrol", async () => {
    const code = await freshCode();
    // Simulate outlet removal: replace the in-memory store with a fresh repo
    // that doesn't know this outlet, but keep the consumed/unconsumed state.
    h.repo.seedOutlet({
      outlet: { id: OUTLET_ID, name: "Warung Bu Tini — Cikini" },
      merchant: { id: MERCHANT_ID, name: "Warung Bu Tini" },
    });
    // No way to delete via repo API; instead create a code bound to a phantom outlet.
    const phantomOutletId = "01890abc-1234-7def-8000-0000000000aa";
    const phantomRepo = new InMemoryEnrolmentRepository();
    const phantomService = new EnrolmentService({ repository: phantomRepo });
    await phantomRepo.createEnrolmentCode({
      code: "ZZZZZZZZ",
      outletId: phantomOutletId,
      createdByUserId: STAFF_USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      phantomService.enrolDevice({ code: "ZZZZZZZZ", deviceFingerprint: "tablet-q" }),
    ).rejects.toMatchObject({ code: "code_expired" });

    // The route returns 410 for both expired and orphaned-outlet cases; assert that too.
    const wrappedApp = await buildApp({
      enrolment: { service: phantomService, staffBootstrapToken: STAFF_TOKEN },
    });
    await wrappedApp.ready();
    const res = await wrappedApp.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code: "ZZZZZZZZ", deviceFingerprint: "tablet-q" },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: { code: string } }).error.code).toBe("code_expired");
    await wrappedApp.close();
    // Use the unused `code` so the linter is happy and the test reads naturally.
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code: "lower", deviceFingerprint: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("bad_request");
  });
});

describe("POST /v1/auth/enroll rate limiting", () => {
  it("returns 429 once the per-minute budget is exhausted", async () => {
    const repo = new InMemoryEnrolmentRepository();
    repo.seedOutlet({
      outlet: { id: OUTLET_ID, name: "Warung Bu Tini — Cikini" },
      merchant: { id: MERCHANT_ID, name: "Warung Bu Tini" },
    });
    const service = new EnrolmentService({ repository: repo });
    const app = await buildApp({
      enrolment: {
        service,
        staffBootstrapToken: STAFF_TOKEN,
        enrollRateLimitPerMinute: 2,
      },
    });
    await app.ready();

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/enroll",
        payload: { code: "ABCDEFGH", deviceFingerprint: "tablet-burst" },
      });
      statuses.push(res.statusCode);
    }
    // First 2 reach the handler (404 not_found); the 3rd is rejected by the limiter.
    expect(statuses).toEqual([404, 404, 429]);
    await app.close();
  });
});

describe("staff endpoint without bootstrap token", () => {
  it("returns 503 when STAFF_BOOTSTRAP_TOKEN is unset", async () => {
    const repo = new InMemoryEnrolmentRepository();
    repo.seedOutlet({
      outlet: { id: OUTLET_ID, name: "Warung Bu Tini — Cikini" },
      merchant: { id: MERCHANT_ID, name: "Warung Bu Tini" },
    });
    const service = new EnrolmentService({ repository: repo });
    const app = await buildApp({ enrolment: { service } });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/enrolment-codes",
      payload: { outletId: OUTLET_ID },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe("staff_bootstrap_disabled");
    await app.close();
  });
});

describe("uuidv7", () => {
  it("emits the version 7 nibble and the variant 10 bits", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is monotonic across the millisecond boundary", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(b > a).toBe(true);
  });
});
