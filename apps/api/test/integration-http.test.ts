import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  runIfIntegration,
  seedItem,
  seedMerchant,
  seedOutlet,
  seedUom,
  staffHeaders,
  startIntegrationServer,
  STAFF_TOKEN,
  type IntegrationHarness,
} from "./helpers/integration-server.js";

/*
 * Real-HTTP, real-Postgres integration tests for `apps/api` (KASA-28).
 *
 * Each `it` starts from a freshly truncated schema (`harness.reset()` in
 * `beforeEach`). Requests use `fetch` against the harness's ephemeral port,
 * proving the full HTTP stack — request parsing, validation, route dispatch,
 * error envelope serialisation — works end-to-end against Postgres.
 *
 * The aggregates exercised here (catalog items, outlets) have Pg repositories;
 * other aggregates keep their in-memory `app.inject` coverage in their own
 * suites until they grow Pg backings.
 */

const STAFF_USER_ID = "01890abc-1234-7def-8000-000000000020";

const MERCHANT_A_ID = "01890abc-1234-7def-8000-00000000aaa1";
const MERCHANT_B_ID = "01890abc-1234-7def-8000-00000000aaa2";

const OUTLET_A1_ID = "01890abc-1234-7def-8000-0000aaaa0001";
const OUTLET_A2_ID = "01890abc-1234-7def-8000-0000aaaa0002";
const OUTLET_B1_ID = "01890abc-1234-7def-8000-0000bbbb0001";

const UOM_A_PCS_ID = "01890abc-1234-7def-8000-0000c0c0c001";
const ITEM_A_KOPI_ID = "01890abc-1234-7def-8000-0000111111a1";
const ITEM_A_TEH_ID = "01890abc-1234-7def-8000-0000111111a2";

interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<JsonResponse<T>> {
  const res = await fetch(url, init);
  // Some endpoints (e.g. 204) may return an empty body; guard the parse.
  const raw = await res.text();
  let body: unknown = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = raw;
    }
  }
  return { status: res.status, body: body as T };
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

interface OutletBody {
  id: string;
  code: string;
  name: string;
  timezone: string;
  updatedAt: string;
}

interface PullEnvelope<T> {
  records: T[];
  nextCursor: string | null;
  nextPageToken: string | null;
}

interface ItemBody {
  id: string;
  code: string;
  name: string;
  priceIdr: number;
  uomId: string;
  bomId: string | null;
  isStockTracked: boolean;
  isActive: boolean;
  updatedAt: string;
}

runIfIntegration("apps/api — real HTTP + Postgres integration suite (KASA-28)", () => {
  let harness: IntegrationHarness | undefined;
  // Inside `it` blocks the harness is always defined — vitest fails the suite
  // up-front if `beforeAll` throws. Wrap the assertion once so each test reads
  // cleanly.
  const h = (): IntegrationHarness => {
    if (!harness) throw new Error("integration harness was not initialised");
    return harness;
  };

  beforeAll(async () => {
    harness = await startIntegrationServer();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.close();
  });

  beforeEach(async () => {
    await h().reset();
  });

  it("GET /health responds 200 with the documented payload over real HTTP", async () => {
    const res = await fetchJson<{
      status: string;
      service: string;
      version: string;
      uptimeSeconds: number;
      timestamp: string;
    }>(`${h().baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("kassa-api");
    expect(typeof res.body.version).toBe("string");
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(() => new Date(res.body.timestamp).toISOString()).not.toThrow();
  });

  it("GET /v1/does-not-exist returns the shared 404 envelope", async () => {
    const res = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("GET /v1/outlets — 401 when no bearer token is presented", async () => {
    const res = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/outlets`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("GET /v1/outlets — 401 when the bearer token is wrong", async () => {
    const res = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/outlets`, {
      headers: {
        authorization: "Bearer not-the-real-token-not-the-real-token",
        "x-staff-user-id": STAFF_USER_ID,
        "x-staff-merchant-id": MERCHANT_A_ID,
      },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("GET /v1/outlets — happy path returns merchant-scoped rows from Postgres", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID, name: "Merchant A" });
    await seedMerchant(h().db, { id: MERCHANT_B_ID, name: "Merchant B" });
    await seedOutlet(h().db, {
      id: OUTLET_A1_ID,
      merchantId: MERCHANT_A_ID,
      code: "JKT-01",
      name: "Jakarta Pusat",
    });
    await seedOutlet(h().db, {
      id: OUTLET_A2_ID,
      merchantId: MERCHANT_A_ID,
      code: "JKT-02",
      name: "Jakarta Selatan",
    });
    await seedOutlet(h().db, {
      id: OUTLET_B1_ID,
      merchantId: MERCHANT_B_ID,
      code: "BDG-01",
      name: "Bandung",
    });

    const res = await fetchJson<PullEnvelope<OutletBody>>(`${h().baseUrl}/v1/outlets`, {
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID),
    });
    expect(res.status).toBe(200);
    const codes = res.body.records.map((row) => row.code).sort();
    expect(codes).toEqual(["JKT-01", "JKT-02"]);
    // Merchant B's outlet must not leak into Merchant A's response.
    expect(res.body.records.every((row) => row.code !== "BDG-01")).toBe(true);
    expect(res.body.nextPageToken).toBeNull();
  });

  it("GET /v1/outlets — tenant isolation: Merchant B sees only its own row", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });
    await seedMerchant(h().db, { id: MERCHANT_B_ID });
    await seedOutlet(h().db, {
      id: OUTLET_A1_ID,
      merchantId: MERCHANT_A_ID,
      code: "JKT-01",
    });
    await seedOutlet(h().db, {
      id: OUTLET_B1_ID,
      merchantId: MERCHANT_B_ID,
      code: "BDG-01",
    });

    const res = await fetchJson<PullEnvelope<OutletBody>>(`${h().baseUrl}/v1/outlets`, {
      headers: staffHeaders(MERCHANT_B_ID, STAFF_USER_ID),
    });
    expect(res.status).toBe(200);
    expect(res.body.records.map((row) => row.code)).toEqual(["BDG-01"]);
  });

  it("GET /v1/outlets — validation: invalid `limit` yields a 422 validation_error", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });

    const res = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/outlets?limit=999999`, {
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("GET /v1/outlets — pagination: nextPageToken round-trips and partitions the rows", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });
    // Three outlets with strictly-increasing updated_at courtesy of separate
    // INSERT statements. Within a transaction `now()` is constant
    // (`transaction_timestamp()`), but each `db.execute()` here auto-commits
    // its own implicit transaction, so each insert sees a later wall clock.
    await seedOutlet(h().db, {
      id: OUTLET_A1_ID,
      merchantId: MERCHANT_A_ID,
      code: "JKT-01",
    });
    await seedOutlet(h().db, {
      id: OUTLET_A2_ID,
      merchantId: MERCHANT_A_ID,
      code: "JKT-02",
    });
    await seedOutlet(h().db, {
      id: OUTLET_B1_ID,
      merchantId: MERCHANT_A_ID,
      code: "JKT-03",
    });

    const first = await fetchJson<PullEnvelope<OutletBody>>(`${h().baseUrl}/v1/outlets?limit=2`, {
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID),
    });
    expect(first.status).toBe(200);
    expect(first.body.records).toHaveLength(2);
    expect(first.body.nextPageToken).not.toBeNull();

    const token = encodeURIComponent(first.body.nextPageToken ?? "");
    const second = await fetchJson<PullEnvelope<OutletBody>>(
      `${h().baseUrl}/v1/outlets?limit=2&pageToken=${token}`,
      { headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID) },
    );
    expect(second.status).toBe(200);
    expect(second.body.records).toHaveLength(1);
    expect(second.body.nextPageToken).toBeNull();

    const allIds = [...first.body.records, ...second.body.records].map((row) => row.id).sort();
    expect(allIds).toEqual([OUTLET_A1_ID, OUTLET_A2_ID, OUTLET_B1_ID].sort());
  });

  it("GET /v1/catalog/items — happy path returns rows persisted in Postgres", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });
    await seedUom(h().db, { id: UOM_A_PCS_ID, merchantId: MERCHANT_A_ID, code: "pcs" });
    await seedItem(h().db, {
      id: ITEM_A_KOPI_ID,
      merchantId: MERCHANT_A_ID,
      code: "KP-001",
      name: "Kopi Susu",
      priceIdr: 25_000,
      uomId: UOM_A_PCS_ID,
    });
    await seedItem(h().db, {
      id: ITEM_A_TEH_ID,
      merchantId: MERCHANT_A_ID,
      code: "TH-001",
      name: "Teh Tarik",
      priceIdr: 18_000,
      uomId: UOM_A_PCS_ID,
    });

    const res = await fetchJson<PullEnvelope<ItemBody>>(`${h().baseUrl}/v1/catalog/items`, {
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID),
    });
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.records.map((row) => [row.code, row]));
    expect(byCode["KP-001"]?.name).toBe("Kopi Susu");
    expect(byCode["KP-001"]?.priceIdr).toBe(25_000);
    expect(byCode["TH-001"]?.name).toBe("Teh Tarik");
  });

  it("GET /v1/catalog/items — 401 when no bearer is presented", async () => {
    const res = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/catalog/items`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("POST /v1/catalog/items — happy path persists the row and round-trips via GET", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });
    await seedUom(h().db, { id: UOM_A_PCS_ID, merchantId: MERCHANT_A_ID, code: "pcs" });

    const post = await fetchJson<ItemBody>(`${h().baseUrl}/v1/catalog/items`, {
      method: "POST",
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        code: "KP-001",
        name: "Kopi Susu",
        priceIdr: 25_000,
        uomId: UOM_A_PCS_ID,
      }),
    });
    expect(post.status).toBe(201);
    expect(post.body.code).toBe("KP-001");
    expect(post.body.priceIdr).toBe(25_000);
    expect(post.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const list = await fetchJson<PullEnvelope<ItemBody>>(`${h().baseUrl}/v1/catalog/items`, {
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID),
    });
    expect(list.status).toBe(200);
    expect(list.body.records.map((row) => row.code)).toEqual(["KP-001"]);
  });

  it("POST /v1/catalog/items — 422 when the request body is missing required fields", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });

    const res = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/catalog/items`, {
      method: "POST",
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ code: "KP-001" }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("POST /v1/catalog/items — 409 on duplicate (merchant_id, code) per the unique index", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });
    await seedUom(h().db, { id: UOM_A_PCS_ID, merchantId: MERCHANT_A_ID, code: "pcs" });

    const body = JSON.stringify({
      code: "KP-001",
      name: "Kopi Susu",
      priceIdr: 25_000,
      uomId: UOM_A_PCS_ID,
    });
    const first = await fetchJson<ItemBody>(`${h().baseUrl}/v1/catalog/items`, {
      method: "POST",
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID, {
        "content-type": "application/json",
      }),
      body,
    });
    expect(first.status).toBe(201);

    const dup = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/catalog/items`, {
      method: "POST",
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID, {
        "content-type": "application/json",
      }),
      body,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("item_code_conflict");
  });

  it("POST /v1/catalog/items — 403 when the staff role is not in the catalog write allow-list", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });
    await seedUom(h().db, { id: UOM_A_PCS_ID, merchantId: MERCHANT_A_ID, code: "pcs" });

    const res = await fetchJson<ErrorEnvelope>(`${h().baseUrl}/v1/catalog/items`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${STAFF_TOKEN}`,
        "x-staff-user-id": STAFF_USER_ID,
        "x-staff-merchant-id": MERCHANT_A_ID,
        "x-staff-role": "cashier",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code: "KP-001",
        name: "Kopi Susu",
        priceIdr: 25_000,
        uomId: UOM_A_PCS_ID,
      }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("DB reset between tests — first test seeds outlets, this test sees none", async () => {
    await seedMerchant(h().db, { id: MERCHANT_A_ID });
    const res = await fetchJson<PullEnvelope<OutletBody>>(`${h().baseUrl}/v1/outlets`, {
      headers: staffHeaders(MERCHANT_A_ID, STAFF_USER_ID),
    });
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
  });
});
