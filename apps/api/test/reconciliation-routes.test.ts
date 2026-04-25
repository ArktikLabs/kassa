import type { FastifyInstance } from "fastify";
import type { PaymentProvider, SettlementReportFilter, SettlementReportRow } from "@kassa/payments";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  InMemoryReconciliationRepository,
  ReconciliationService,
} from "../src/services/reconciliation/index.js";

/*
 * Wire-level coverage for the KASA-117 admin reconciliation endpoints.
 * The matcher and orchestration are exercised in
 * `reconciliation-matcher.test.ts` and `reconciliation-service.test.ts`
 * — this suite is about the HTTP shape: owner-only enforcement, Zod
 * validation, and that a real run flips a tender end-to-end.
 */

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const MERCHANT = "01890abc-1234-7def-8000-00000000aaa1";
const OUTLET = "01890abc-1234-7def-8000-000000000001";
const STAFF_USER = "01890abc-1234-7def-8000-000000000020";
const TENDER_MATCHED = "01890abc-1234-7def-8000-000000000301";
const TENDER_STUCK = "01890abc-1234-7def-8000-000000000302";
const TENDER_UNKNOWN = "01890abc-1234-7def-8000-000000000fff";
const SALE_MATCHED = "01890abc-1234-7def-8000-000000000401";
const SALE_STUCK = "01890abc-1234-7def-8000-000000000402";
const BUSINESS_DATE = "2026-04-22";

function fakeProvider(rows: readonly SettlementReportRow[]): PaymentProvider {
  return {
    name: "fake",
    async createQris() {
      throw new Error("not used");
    },
    async getQrisStatus() {
      throw new Error("not used");
    },
    verifyWebhookSignature() {
      throw new Error("not used");
    },
    async fetchQrisSettlements(_filter: SettlementReportFilter) {
      return rows;
    },
  };
}

interface Harness {
  app: FastifyInstance;
  repo: InMemoryReconciliationRepository;
}

async function setup(rows: readonly SettlementReportRow[] = []): Promise<Harness> {
  const repo = new InMemoryReconciliationRepository();
  const service = new ReconciliationService({
    repository: repo,
    provider: fakeProvider(rows),
    now: () => new Date("2026-04-23T00:00:00.000Z"),
  });
  const app = await buildApp({
    reconciliation: { service, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app, repo };
}

function ownerHeaders(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER,
    "x-staff-merchant-id": MERCHANT,
    "x-staff-role": "owner",
    "content-type": "application/json",
    ...overrides,
  };
}

describe("POST /v1/admin/reconciliation/run", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.app.close();
  });

  it("happy path: flips an unverified tender that pairs with a settlement row", async () => {
    h = await setup([
      {
        providerTransactionId: "mt-A",
        grossAmountIdr: 25_000,
        last4: "1234",
        settledAt: "2026-04-22T13:32:00+07:00",
        outletId: OUTLET,
      },
    ]);
    h.repo.seedTender({
      tenderId: TENDER_MATCHED,
      saleId: SALE_MATCHED,
      merchantId: MERCHANT,
      outletId: OUTLET,
      businessDate: BUSINESS_DATE,
      amountIdr: 25_000,
      buyerRefLast4: "1234",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });
    h.repo.seedTender({
      tenderId: TENDER_STUCK,
      saleId: SALE_STUCK,
      merchantId: MERCHANT,
      outletId: OUTLET,
      businessDate: BUSINESS_DATE,
      amountIdr: 50_000,
      buyerRefLast4: "9999",
      saleCreatedAt: "2026-04-22T14:00:00+07:00",
    });

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/run",
      headers: ownerHeaders(),
      payload: { outletId: OUTLET, businessDate: BUSINESS_DATE },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matchedCount: number;
      consideredTenderCount: number;
      settlementRowCount: number;
      matches: ReadonlyArray<{ tenderId: string; providerTransactionId: string }>;
      unmatchedTenderIds: readonly string[];
      unmatchedSettlementIds: readonly string[];
    };
    expect(body.matchedCount).toBe(1);
    expect(body.consideredTenderCount).toBe(2);
    expect(body.settlementRowCount).toBe(1);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]?.tenderId).toBe(TENDER_MATCHED);
    expect(body.matches[0]?.providerTransactionId).toBe("mt-A");
    expect(body.unmatchedTenderIds).toEqual([TENDER_STUCK]);
    expect(h.repo.isVerified(TENDER_MATCHED)).toBe(true);
    expect(h.repo.isVerified(TENDER_STUCK)).toBe(false);
  });

  it("403 forbidden when the staff role is not owner", async () => {
    h = await setup();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/run",
      headers: ownerHeaders({ "x-staff-role": "manager" }),
      payload: { outletId: OUTLET, businessDate: BUSINESS_DATE },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("422 when businessDate is malformed", async () => {
    h = await setup();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/run",
      headers: ownerHeaders(),
      payload: { outletId: OUTLET, businessDate: "yesterday" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("401 when the staff session is missing", async () => {
    h = await setup();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/run",
      payload: { outletId: OUTLET, businessDate: BUSINESS_DATE },
    });
    expect(res.statusCode).toBe(401);
  });

  it("503 when STAFF_BOOTSTRAP_TOKEN is not set", async () => {
    const repo = new InMemoryReconciliationRepository();
    const service = new ReconciliationService({
      repository: repo,
      provider: fakeProvider([]),
    });
    const app = await buildApp({ reconciliation: { service } });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/admin/reconciliation/run",
        payload: { outletId: OUTLET, businessDate: BUSINESS_DATE },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "staff_bootstrap_disabled",
      );
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/admin/reconciliation/match", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    h.repo.seedTender({
      tenderId: TENDER_STUCK,
      saleId: SALE_STUCK,
      merchantId: MERCHANT,
      outletId: OUTLET,
      businessDate: BUSINESS_DATE,
      amountIdr: 75_000,
      buyerRefLast4: "4242",
      saleCreatedAt: "2026-04-22T14:00:00+07:00",
    });
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("flips a single tender and records the audit row", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/match",
      headers: ownerHeaders(),
      payload: {
        tenderId: TENDER_STUCK,
        providerTransactionId: "mt-MANUAL-1",
        note: "Buyer kirim screenshot transfer BCA 4242, cocokkan manual.",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tenderId: string; outcome: string };
    expect(body).toEqual({ tenderId: TENDER_STUCK, outcome: "flipped" });
    expect(h.repo.isVerified(TENDER_STUCK)).toBe(true);
    const audit = h.repo.manualMatchAuditFor(TENDER_STUCK);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenderId: TENDER_STUCK,
      providerTransactionId: "mt-MANUAL-1",
      staffUserId: STAFF_USER,
    });
  });

  it("idempotent retry against an already-verified tender returns outcome=noop", async () => {
    const first = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/match",
      headers: ownerHeaders(),
      payload: {
        tenderId: TENDER_STUCK,
        providerTransactionId: null,
        note: "Tunai langsung dari pembeli — skip Midtrans.",
      },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { outcome: string }).outcome).toBe("flipped");

    const second = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/match",
      headers: ownerHeaders(),
      payload: {
        tenderId: TENDER_STUCK,
        providerTransactionId: null,
        note: "Tunai langsung dari pembeli — skip Midtrans.",
      },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { outcome: string }).outcome).toBe("noop");
  });

  it("404 when the tender belongs to a different merchant", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/match",
      headers: ownerHeaders(),
      payload: {
        tenderId: TENDER_UNKNOWN,
        providerTransactionId: "mt-X",
        note: "test",
      },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("tender_not_found");
  });

  it("422 when the note is missing", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/match",
      headers: ownerHeaders(),
      payload: {
        tenderId: TENDER_STUCK,
        providerTransactionId: "mt-X",
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("403 forbidden when the staff role is not owner", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/reconciliation/match",
      headers: ownerHeaders({ "x-staff-role": "cashier" }),
      payload: {
        tenderId: TENDER_STUCK,
        providerTransactionId: "mt-X",
        note: "tidak boleh",
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
