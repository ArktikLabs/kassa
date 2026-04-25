import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  encodeApiKey,
  generateApiSecret,
  hashApiSecret,
} from "../src/services/enrolment/credentials.js";
import {
  FakeDeviceAuthRepository,
  seedTestDevice,
  type TestDeviceCredentials,
} from "./helpers/device-auth.js";

const DEVICE_ID = "01963f8a-bbbb-7000-8000-000000000001";
const MERCHANT_ID = "01963f8a-bbbb-7000-8000-000000000099";
const OUTLET_ID = "01963f8a-bbbb-7000-8000-000000000010";
const ORDER_ID = "01963f8a-bbbb-7456-8abc-0123456789ab";

const PROTECTED_URL = `/v1/payments/qris/${ORDER_ID}/status`;

interface Harness {
  app: FastifyInstance;
  repository: FakeDeviceAuthRepository;
  cred: TestDeviceCredentials;
}

async function setup(): Promise<Harness> {
  const repository = new FakeDeviceAuthRepository();
  const cred = await seedTestDevice(repository, {
    deviceId: DEVICE_ID,
    merchantId: MERCHANT_ID,
    outletId: OUTLET_ID,
  });
  const app = await buildApp({ deviceAuth: { repository } });
  await app.ready();
  return { app, repository, cred };
}

describe("device-auth middleware (KASA-25)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("returns 401 unauthorized when the Authorization header is missing", async () => {
    const res = await h.app.inject({ method: "GET", url: PROTECTED_URL });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toMatch(/device credentials/i);
  });

  it("returns 401 when the scheme is not Basic", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: { authorization: `Bearer ${h.cred.apiKey}:${h.cred.apiSecret}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the Basic blob is malformed (no colon)", async () => {
    const malformed = `Basic ${Buffer.from("kk_dev_garbage", "utf8").toString("base64")}`;
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: { authorization: malformed },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the apiKey does not match the kk_dev_<base64url> shape", async () => {
    const blob = `kk_dev_!!!:${h.cred.apiSecret}`;
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: {
        authorization: `Basic ${Buffer.from(blob, "utf8").toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for a well-formed apiKey that maps to no device row", async () => {
    const phantomKey = encodeApiKey("01963f8a-cafe-7000-8000-deadbeefdead");
    const blob = `${phantomKey}:${h.cred.apiSecret}`;
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: {
        authorization: `Basic ${Buffer.from(blob, "utf8").toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the apiSecret does not match the stored hash", async () => {
    const wrongSecret = generateApiSecret();
    const blob = `${h.cred.apiKey}:${wrongSecret}`;
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: {
        authorization: `Basic ${Buffer.from(blob, "utf8").toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for a revoked device even with the correct secret", async () => {
    h.repository.setStatus(DEVICE_ID, "revoked");
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: { authorization: h.cred.authHeader },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the apiSecret matches a different device's hash (cross-device replay)", async () => {
    const otherDeviceId = "01963f8a-cccc-7000-8000-000000000001";
    const otherSecret = generateApiSecret();
    h.repository.add({
      id: otherDeviceId,
      merchantId: MERCHANT_ID,
      outletId: OUTLET_ID,
      apiKeyHash: await hashApiSecret(otherSecret),
      status: "active",
    });
    // Send the *first* device's apiKey paired with the *second* device's
    // secret — neither hash matches what the lookup returns, so the request
    // must 401 instead of leaking either side.
    const blob = `${h.cred.apiKey}:${otherSecret}`;
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: {
        authorization: `Basic ${Buffer.from(blob, "utf8").toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("authenticates a valid device and reaches the downstream handler", async () => {
    // No Midtrans provider is configured in the harness, so a successful
    // device-auth lands on the 503 payments_unavailable path. That's the
    // proof the gate let the request through — it didn't 401.
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: { authorization: h.cred.authHeader },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe("payments_unavailable");
  });

  it("records a touchDevice call after successful auth so lastSeenAt can be bumped", async () => {
    const before = h.repository.touched.length;
    const res = await h.app.inject({
      method: "GET",
      url: PROTECTED_URL,
      headers: { authorization: h.cred.authHeader },
    });
    expect(res.statusCode).toBe(503);
    // touchDevice is fire-and-forget; the await above ensures the
    // microtask has at least been scheduled, but in practice the
    // FakeDeviceAuthRepository resolves synchronously so the call has
    // already landed by the time inject() returns.
    expect(h.repository.touched.length).toBeGreaterThan(before);
    expect(h.repository.touched.at(-1)?.deviceId).toBe(DEVICE_ID);
  });

  it("does not gate the unauthenticated bootstrap routes (/v1/auth/enroll)", async () => {
    // The enrol route is reachable without device credentials so a fresh
    // tablet can bootstrap. We confirm the gate did NOT fire by checking
    // that the response is the route's own 422 validation_error for a
    // malformed payload — not the gate's 401 unauthorized.
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: { code: "lower", deviceFingerprint: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });
});
