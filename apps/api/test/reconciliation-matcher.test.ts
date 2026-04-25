import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECONCILIATION_WINDOW_MS,
  reconcileStaticQrisTenders,
} from "../src/services/reconciliation/matcher.js";
import type {
  SettlementReportRow,
  UnverifiedStaticQrisTender,
} from "../src/services/reconciliation/types.js";

/*
 * Acceptance-criteria coverage for KASA-64 reconciliation matcher.
 * The four required cases the issue calls out:
 *   1. happy path: every tender pairs with its settlement row
 *   2. no-match: the settlement report has no row that fits any tender
 *   3. amount mismatch: same last4 + outlet + window but different IDR
 *   4. partial across outlets: same last4 + amount but different outlets
 *
 * Plus a few invariants the matcher is responsible for: window enforcement,
 * single-use settlement rows, deterministic tie-break.
 */

const tenderBase: Omit<UnverifiedStaticQrisTender, "tenderId" | "saleId"> = {
  outletId: "outlet-jaksel",
  amountIdr: 25_000,
  buyerRefLast4: "1234",
  saleCreatedAt: "2026-04-22T13:30:00+07:00",
};

const rowBase: Omit<SettlementReportRow, "providerTransactionId"> = {
  outletId: "outlet-jaksel",
  grossAmountIdr: 25_000,
  last4: "1234",
  settledAt: "2026-04-22T13:32:30+07:00",
};

function tender(
  overrides: Partial<UnverifiedStaticQrisTender> & { tenderId: string },
): UnverifiedStaticQrisTender {
  return { ...tenderBase, saleId: `sale-${overrides.tenderId}`, ...overrides };
}

function row(
  overrides: Partial<SettlementReportRow> & { providerTransactionId: string },
): SettlementReportRow {
  return { ...rowBase, ...overrides };
}

describe("reconcileStaticQrisTenders", () => {
  it("matches every tender against its settlement row on the happy path", () => {
    const tenders = [
      tender({ tenderId: "t-1" }),
      tender({
        tenderId: "t-2",
        amountIdr: 80_000,
        buyerRefLast4: "5678",
        saleCreatedAt: "2026-04-22T14:01:00+07:00",
      }),
    ];
    const rows = [
      row({ providerTransactionId: "mt-A" }),
      row({
        providerTransactionId: "mt-B",
        grossAmountIdr: 80_000,
        last4: "5678",
        settledAt: "2026-04-22T14:03:15+07:00",
      }),
    ];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toHaveLength(2);
    expect(result.unmatchedTenderIds).toEqual([]);
    expect(result.unmatchedSettlementIds).toEqual([]);
    const byTender = new Map(result.matches.map((m) => [m.tenderId, m.providerTransactionId]));
    expect(byTender.get("t-1")).toBe("mt-A");
    expect(byTender.get("t-2")).toBe("mt-B");
  });

  it("returns the tender as unmatched when no settlement row fits", () => {
    const tenders = [tender({ tenderId: "t-1" })];
    const rows: SettlementReportRow[] = [];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toEqual([]);
    expect(result.unmatchedTenderIds).toEqual(["t-1"]);
    expect(result.unmatchedSettlementIds).toEqual([]);
  });

  it("does not match when amount differs even with last4 + outlet + window aligned", () => {
    const tenders = [tender({ tenderId: "t-1" })];
    const rows = [
      row({ providerTransactionId: "mt-A", grossAmountIdr: 25_500 }), // off by 500 IDR
    ];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toEqual([]);
    expect(result.unmatchedTenderIds).toEqual(["t-1"]);
    expect(result.unmatchedSettlementIds).toEqual(["mt-A"]);
  });

  it("isolates partial matches across outlets — last4 + amount alone is not enough", () => {
    // Two outlets, same last4 + amount + similar window. The tender at
    // outlet A must match its A row; the tender at outlet B must match its
    // B row. Cross-outlet pairing must not happen even if the times line
    // up better that way.
    const tenders = [
      tender({
        tenderId: "t-jaksel",
        outletId: "outlet-jaksel",
        saleCreatedAt: "2026-04-22T13:30:00+07:00",
      }),
      tender({
        tenderId: "t-surabaya",
        outletId: "outlet-surabaya",
        saleCreatedAt: "2026-04-22T13:30:30+07:00",
      }),
    ];
    const rows = [
      row({
        providerTransactionId: "mt-jaksel",
        outletId: "outlet-jaksel",
        settledAt: "2026-04-22T13:35:00+07:00",
      }),
      row({
        providerTransactionId: "mt-surabaya",
        outletId: "outlet-surabaya",
        settledAt: "2026-04-22T13:31:00+07:00",
      }),
    ];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toHaveLength(2);
    expect(result.unmatchedTenderIds).toEqual([]);
    expect(result.unmatchedSettlementIds).toEqual([]);
    const byTender = new Map(result.matches.map((m) => [m.tenderId, m.providerTransactionId]));
    expect(byTender.get("t-jaksel")).toBe("mt-jaksel");
    expect(byTender.get("t-surabaya")).toBe("mt-surabaya");
  });

  it("rejects matches outside the ±10-minute window", () => {
    const tenders = [tender({ tenderId: "t-1" })];
    const rows = [
      // 15 min after sale — outside the default 10-min window.
      row({ providerTransactionId: "mt-late", settledAt: "2026-04-22T13:45:30+07:00" }),
    ];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toEqual([]);
    expect(result.unmatchedTenderIds).toEqual(["t-1"]);
    expect(result.unmatchedSettlementIds).toEqual(["mt-late"]);
  });

  it("respects a custom windowMs override", () => {
    const tenders = [tender({ tenderId: "t-1" })];
    const rows = [
      row({ providerTransactionId: "mt-late", settledAt: "2026-04-22T13:45:30+07:00" }),
    ];

    const result = reconcileStaticQrisTenders(tenders, rows, { windowMs: 20 * 60 * 1000 });

    expect(result.matches).toEqual([
      { tenderId: "t-1", providerTransactionId: "mt-late", settledAt: "2026-04-22T13:45:30+07:00" },
    ]);
  });

  it("never reuses a settlement row for two tenders", () => {
    // Two identical tenders + only one settlement row. First tender pairs;
    // the second must be unmatched.
    const tenders = [
      tender({ tenderId: "t-A", saleCreatedAt: "2026-04-22T13:30:00+07:00" }),
      tender({ tenderId: "t-B", saleCreatedAt: "2026-04-22T13:31:00+07:00" }),
    ];
    const rows = [row({ providerTransactionId: "mt-only" })];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.tenderId).toBe("t-A"); // chronologically first
    expect(result.unmatchedTenderIds).toEqual(["t-B"]);
    expect(result.unmatchedSettlementIds).toEqual([]);
  });

  it("picks the closest-in-time settlement row when several qualify", () => {
    const tenders = [tender({ tenderId: "t-1", saleCreatedAt: "2026-04-22T13:30:00+07:00" })];
    const rows = [
      row({ providerTransactionId: "mt-far", settledAt: "2026-04-22T13:39:00+07:00" }), // +9 min
      row({ providerTransactionId: "mt-near", settledAt: "2026-04-22T13:31:00+07:00" }), // +1 min
    ];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toEqual([
      { tenderId: "t-1", providerTransactionId: "mt-near", settledAt: "2026-04-22T13:31:00+07:00" },
    ]);
    expect(result.unmatchedSettlementIds).toEqual(["mt-far"]);
  });

  it("breaks equal-distance ties by lexicographic providerTransactionId", () => {
    // Two settlement rows are equidistant from the sale time; the matcher
    // must pick the lexicographically smaller `providerTransactionId` so
    // reruns are stable.
    const tenders = [tender({ tenderId: "t-1", saleCreatedAt: "2026-04-22T13:30:00+07:00" })];
    const rows = [
      row({ providerTransactionId: "mt-Z", settledAt: "2026-04-22T13:32:00+07:00" }),
      row({ providerTransactionId: "mt-A", settledAt: "2026-04-22T13:28:00+07:00" }),
    ];

    const result = reconcileStaticQrisTenders(tenders, rows);

    expect(result.matches).toEqual([
      { tenderId: "t-1", providerTransactionId: "mt-A", settledAt: "2026-04-22T13:28:00+07:00" },
    ]);
  });

  it("exposes DEFAULT_RECONCILIATION_WINDOW_MS at 10 minutes", () => {
    expect(DEFAULT_RECONCILIATION_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it("throws on unparseable timestamps so a bad row is loud, not silently dropped", () => {
    const tenders = [tender({ tenderId: "t-1", saleCreatedAt: "not-a-date" })];
    const rows = [row({ providerTransactionId: "mt-A" })];

    expect(() => reconcileStaticQrisTenders(tenders, rows)).toThrow(/saleCreatedAt/);
  });
});
