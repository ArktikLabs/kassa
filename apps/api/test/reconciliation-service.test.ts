import { describe, expect, it } from "vitest";
import type { PaymentProvider, SettlementReportFilter, SettlementReportRow } from "@kassa/payments";
import {
  InMemoryReconciliationRepository,
  ReconciliationService,
} from "../src/services/reconciliation/index.js";

/*
 * Integration suite for the reconciliation orchestration: pulls unverified
 * tenders from the repo, asks the provider for settlements, runs the
 * matcher, flips the matched tenders. The matcher itself is exercised in
 * `reconciliation-matcher.test.ts`; this suite is about the wiring.
 */

function fakeProvider(rows: readonly SettlementReportRow[]): PaymentProvider {
  return {
    name: "fake",
    async createQris() {
      throw new Error("not used in this suite");
    },
    async getQrisStatus() {
      throw new Error("not used in this suite");
    },
    verifyWebhookSignature() {
      throw new Error("not used in this suite");
    },
    async fetchQrisSettlements(_filter: SettlementReportFilter) {
      return rows;
    },
  };
}

const merchantId = "merchant-1";
const outletId = "outlet-jaksel";
const businessDate = "2026-04-22";

describe("ReconciliationService", () => {
  it("flips matched tenders to verified and reports the counts", async () => {
    const repo = new InMemoryReconciliationRepository();
    repo.seedTender({
      tenderId: "t-1",
      saleId: "s-1",
      merchantId,
      outletId,
      businessDate,
      amountIdr: 25_000,
      buyerRefLast4: "1234",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });
    repo.seedTender({
      tenderId: "t-2",
      saleId: "s-2",
      merchantId,
      outletId,
      businessDate,
      amountIdr: 50_000,
      buyerRefLast4: "5678",
      saleCreatedAt: "2026-04-22T14:00:00+07:00",
    });

    const provider = fakeProvider([
      {
        providerTransactionId: "mt-A",
        grossAmountIdr: 25_000,
        last4: "1234",
        settledAt: "2026-04-22T13:32:00+07:00",
        outletId,
      },
      // No row for t-2 — left unmatched.
    ]);

    const svc = new ReconciliationService({ repository: repo, provider });
    const report = await svc.reconcileBusinessDate({ merchantId, outletId, businessDate });

    expect(report.matchedCount).toBe(1);
    expect(report.consideredTenderCount).toBe(2);
    expect(report.settlementRowCount).toBe(1);
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0]?.tenderId).toBe("t-1");
    expect(report.unmatchedTenderIds).toEqual(["t-2"]);

    expect(repo.isVerified("t-1")).toBe(true);
    expect(repo.isVerified("t-2")).toBe(false);
  });

  it("scopes to the requested (merchant, outlet, businessDate) — sister outlet rows are not flipped", async () => {
    const repo = new InMemoryReconciliationRepository();
    repo.seedTender({
      tenderId: "t-jaksel",
      saleId: "s-1",
      merchantId,
      outletId: "outlet-jaksel",
      businessDate,
      amountIdr: 10_000,
      buyerRefLast4: "1111",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });
    repo.seedTender({
      tenderId: "t-surabaya",
      saleId: "s-2",
      merchantId,
      outletId: "outlet-surabaya",
      businessDate,
      amountIdr: 10_000,
      buyerRefLast4: "1111",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });

    // The fake settlement client returns rows for *both* outlets. The
    // service only asks for one outlet, so the matcher must scope to that.
    const provider = fakeProvider([
      {
        providerTransactionId: "mt-jaksel",
        grossAmountIdr: 10_000,
        last4: "1111",
        settledAt: "2026-04-22T13:31:00+07:00",
        outletId: "outlet-jaksel",
      },
      {
        providerTransactionId: "mt-surabaya",
        grossAmountIdr: 10_000,
        last4: "1111",
        settledAt: "2026-04-22T13:31:30+07:00",
        outletId: "outlet-surabaya",
      },
    ]);

    const svc = new ReconciliationService({ repository: repo, provider });
    await svc.reconcileBusinessDate({ merchantId, outletId: "outlet-jaksel", businessDate });

    expect(repo.isVerified("t-jaksel")).toBe(true);
    expect(repo.isVerified("t-surabaya")).toBe(false);
  });

  it("is idempotent: a re-run on the same date does not double-flip already-verified rows", async () => {
    const repo = new InMemoryReconciliationRepository();
    repo.seedTender({
      tenderId: "t-1",
      saleId: "s-1",
      merchantId,
      outletId,
      businessDate,
      amountIdr: 25_000,
      buyerRefLast4: "1234",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });
    const provider = fakeProvider([
      {
        providerTransactionId: "mt-A",
        grossAmountIdr: 25_000,
        last4: "1234",
        settledAt: "2026-04-22T13:32:00+07:00",
        outletId,
      },
    ]);

    const svc = new ReconciliationService({ repository: repo, provider });
    const first = await svc.reconcileBusinessDate({ merchantId, outletId, businessDate });
    const second = await svc.reconcileBusinessDate({ merchantId, outletId, businessDate });

    expect(first.matchedCount).toBe(1);
    // Second pass surfaces zero unverified rows, so nothing to flip and
    // nothing to ask the provider for; importantly, the repo's `markMatched`
    // does not crash if asked to re-flip a row.
    expect(second.matchedCount).toBe(0);
    expect(second.consideredTenderCount).toBe(0);
  });

  it("reports zero matches when the provider returns no rows", async () => {
    const repo = new InMemoryReconciliationRepository();
    repo.seedTender({
      tenderId: "t-1",
      saleId: "s-1",
      merchantId,
      outletId,
      businessDate,
      amountIdr: 25_000,
      buyerRefLast4: "1234",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });
    const provider = fakeProvider([]);

    const svc = new ReconciliationService({ repository: repo, provider });
    const report = await svc.reconcileBusinessDate({ merchantId, outletId, businessDate });

    expect(report.matchedCount).toBe(0);
    expect(report.consideredTenderCount).toBe(1);
    expect(report.settlementRowCount).toBe(0);
    expect(report.unmatchedTenderIds).toEqual(["t-1"]);
    expect(repo.isVerified("t-1")).toBe(false);
  });

  it("forwards the configured window override to the matcher", async () => {
    const repo = new InMemoryReconciliationRepository();
    repo.seedTender({
      tenderId: "t-1",
      saleId: "s-1",
      merchantId,
      outletId,
      businessDate,
      amountIdr: 25_000,
      buyerRefLast4: "1234",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });
    // Settlement is 12 minutes after sale — outside default 10-min window.
    const provider = fakeProvider([
      {
        providerTransactionId: "mt-A",
        grossAmountIdr: 25_000,
        last4: "1234",
        settledAt: "2026-04-22T13:42:00+07:00",
        outletId,
      },
    ]);

    const tightSvc = new ReconciliationService({ repository: repo, provider });
    const tight = await tightSvc.reconcileBusinessDate({ merchantId, outletId, businessDate });
    expect(tight.matchedCount).toBe(0);

    const wideRepo = new InMemoryReconciliationRepository();
    wideRepo.seedTender({
      tenderId: "t-1",
      saleId: "s-1",
      merchantId,
      outletId,
      businessDate,
      amountIdr: 25_000,
      buyerRefLast4: "1234",
      saleCreatedAt: "2026-04-22T13:30:00+07:00",
    });
    const wideSvc = new ReconciliationService({
      repository: wideRepo,
      provider,
      windowMs: 20 * 60 * 1000,
    });
    const wide = await wideSvc.reconcileBusinessDate({ merchantId, outletId, businessDate });
    expect(wide.matchedCount).toBe(1);
  });
});
