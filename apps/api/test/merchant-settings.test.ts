import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MerchantMeResponse } from "@kassa/schemas";
import { buildApp } from "../src/app.js";
import { InMemoryMerchantsRepository, MerchantsService } from "../src/services/merchants/index.js";

/*
 * Wire-level coverage for KASA-221 — `GET /v1/merchant/me` and
 * `PATCH /v1/merchant`. Round-trips the in-memory repository through the
 * full Fastify stack so the auth gating, schema validation, and the
 * `displayName` fall-through to the merchant `name` are all exercised.
 */

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT = "01890abc-1234-7def-8000-00000000a221";
const OTHER_MERCHANT = "01890abc-1234-7def-8000-00000000a222";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const SEED_CREATED_AT = new Date("2026-04-01T00:00:00.000Z");
const SEED_UPDATED_AT = new Date("2026-04-22T11:30:00.000Z");

interface Harness {
  app: FastifyInstance;
  repo: InMemoryMerchantsRepository;
  clock: () => Date;
  setNow: (next: Date) => void;
}

async function setup(): Promise<Harness> {
  let now = new Date("2026-04-23T08:00:00.000Z");
  const clock = () => now;
  const repo = new InMemoryMerchantsRepository({ now: clock });
  repo.seedMerchant({
    id: MERCHANT,
    name: "Warung Pak Slamet",
    createdAt: SEED_CREATED_AT,
    updatedAt: SEED_UPDATED_AT,
  });
  const service = new MerchantsService({ repository: repo });
  const app = await buildApp({
    merchant: { service, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return {
    app,
    repo,
    clock,
    setNow: (next) => {
      now = next;
    },
  };
}

function staffHeaders(
  role: "owner" | "manager" | "cashier" | "read_only" = "owner",
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT,
    "x-staff-role": role,
    "content-type": "application/json",
    ...overrides,
  };
}

describe("GET /v1/merchant/me", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("returns the seeded settings with displayName falling back to merchant name", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/merchant/me",
      headers: staffHeaders("cashier"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MerchantMeResponse;
    expect(body).toEqual({
      id: MERCHANT,
      settings: {
        displayName: "Warung Pak Slamet",
        addressLine: null,
        phone: null,
        npwp: null,
        receiptFooterText: null,
      },
      updatedAt: SEED_UPDATED_AT.toISOString(),
    });
  });

  it("401s when no staff session is present", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/merchant/me" });
    expect(res.statusCode).toBe(401);
  });

  it("404s when the staff session names a merchant that does not exist", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/merchant/me",
      headers: staffHeaders("owner", { "x-staff-merchant-id": OTHER_MERCHANT }),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("merchant_not_found");
  });

  it("503s when STAFF_BOOTSTRAP_TOKEN is not configured", async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/merchant/me" });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /v1/merchant", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("owner: updates the receipt branding and bumps updatedAt", async () => {
    const next = new Date("2026-04-24T10:00:00.000Z");
    h.setNow(next);
    const res = await h.app.inject({
      method: "PATCH",
      url: "/v1/merchant",
      headers: staffHeaders("owner"),
      payload: {
        displayName: "Warung Pak Slamet — Cabang Senayan",
        addressLine: "Jl. Senayan No. 12, Jakarta",
        phone: "+62 21 555 1212",
        npwp: "1234567890123456",
        receiptFooterText: "Terima kasih atas kunjungan Anda",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MerchantMeResponse;
    expect(body.settings).toEqual({
      displayName: "Warung Pak Slamet — Cabang Senayan",
      addressLine: "Jl. Senayan No. 12, Jakarta",
      phone: "+62 21 555 1212",
      npwp: "1234567890123456",
      receiptFooterText: "Terima kasih atas kunjungan Anda",
    });
    expect(body.updatedAt).toBe(next.toISOString());
    // Round-trip via GET to confirm the in-memory repo persisted the write.
    const refetch = await h.app.inject({
      method: "GET",
      url: "/v1/merchant/me",
      headers: staffHeaders("cashier"),
    });
    expect((refetch.json() as MerchantMeResponse).settings).toEqual(body.settings);
  });

  it("owner: clears nullable fields when explicitly set to null", async () => {
    await h.app.inject({
      method: "PATCH",
      url: "/v1/merchant",
      headers: staffHeaders("owner"),
      payload: { phone: "+62 21 555 1212", addressLine: "Jl. Senayan No. 12" },
    });
    const cleared = await h.app.inject({
      method: "PATCH",
      url: "/v1/merchant",
      headers: staffHeaders("owner"),
      payload: { phone: null },
    });
    expect(cleared.statusCode).toBe(200);
    const body = cleared.json() as MerchantMeResponse;
    expect(body.settings.phone).toBeNull();
    // addressLine was not in the second body so it must survive untouched.
    expect(body.settings.addressLine).toBe("Jl. Senayan No. 12");
  });

  it("rejects manager/cashier/read_only with 403", async () => {
    for (const role of ["manager", "cashier", "read_only"] as const) {
      const res = await h.app.inject({
        method: "PATCH",
        url: "/v1/merchant",
        headers: staffHeaders(role),
        payload: { displayName: "Should not stick" },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it.each([
    { field: "npwp", value: "12345" },
    { field: "npwp", value: "12345678901234567" },
    { field: "npwp", value: "abcdefghijklmnop" },
    { field: "phone", value: "0812-RING-RING" },
    { field: "displayName", value: "" },
    { field: "addressLine", value: "X".repeat(161) },
    { field: "receiptFooterText", value: "Y".repeat(141) },
  ])("422s on invalid $field=$value", async ({ field, value }) => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/v1/merchant",
      headers: staffHeaders("owner"),
      payload: { [field]: value },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects unknown fields with 422 (.strict() schema)", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/v1/merchant",
      headers: staffHeaders("owner"),
      payload: { logoUrl: "https://example.test/logo.png" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("404s when the staff session names a merchant that does not exist", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/v1/merchant",
      headers: staffHeaders("owner", { "x-staff-merchant-id": OTHER_MERCHANT }),
      payload: { displayName: "Phantom" },
    });
    expect(res.statusCode).toBe(404);
  });
});
