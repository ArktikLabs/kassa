import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDatabaseSingletonForTest, DB_NAME, getDatabase } from "../../data/db/index.ts";
import type { NewPendingSale } from "../../data/db/pending-sales.ts";
import { enqueueVoid } from "./voidRepository.ts";
import { toRupiah } from "../../shared/money/index.ts";

const NOW = () => new Date("2026-05-12T09:30:00.000Z");

function makeSale(overrides: Partial<NewPendingSale> = {}): NewPendingSale {
  return {
    localSaleId: overrides.localSaleId ?? "11111111-1111-7000-8000-000000000001",
    outletId: overrides.outletId ?? "22222222-2222-7000-8000-000000000002",
    clerkId: overrides.clerkId ?? "device-1",
    businessDate: overrides.businessDate ?? "2026-05-12",
    createdAt: overrides.createdAt ?? "2026-05-12T08:00:00.000Z",
    subtotalIdr: overrides.subtotalIdr ?? toRupiah(50_000),
    discountIdr: overrides.discountIdr ?? toRupiah(0),
    totalIdr: overrides.totalIdr ?? toRupiah(50_000),
    items: overrides.items ?? [],
    tenders: overrides.tenders ?? [],
  };
}

beforeEach(async () => {
  _resetDatabaseSingletonForTest();
  await Dexie.delete(DB_NAME);
});

afterEach(async () => {
  _resetDatabaseSingletonForTest();
  await Dexie.delete(DB_NAME);
});

describe("enqueueVoid", () => {
  it("writes a `pending_voids` outbox row and optimistically marks the sale voided", async () => {
    const db = await getDatabase();
    const sale = makeSale();
    await db.repos.pendingSales.enqueue(sale);

    const { row } = await enqueueVoid({
      saleId: "sale-server-id-xyz",
      localSaleId: sale.localSaleId,
      outletId: sale.outletId,
      managerStaffId: "33333333-3333-7000-8000-000000000003",
      managerPin: "9876",
      voidBusinessDate: "2026-05-12",
      reason: "salah input item",
      now: NOW,
    });

    expect(row).toMatchObject({
      saleId: "sale-server-id-xyz",
      localSaleId: sale.localSaleId,
      outletId: sale.outletId,
      managerStaffId: "33333333-3333-7000-8000-000000000003",
      managerPin: "9876",
      voidedAt: "2026-05-12T09:30:00.000Z",
      voidBusinessDate: "2026-05-12",
      reason: "salah input item",
      status: "queued",
      attempts: 0,
    });
    expect(row.localVoidId).toMatch(/^[0-9a-f-]{36}$/);

    const reread = await db.repos.pendingVoids.getById(row.localVoidId);
    expect(reread?.status).toBe("queued");

    const sib = await db.repos.pendingSales.getById(sale.localSaleId);
    expect(sib?.voidedAt).toBe("2026-05-12T09:30:00.000Z");
    expect(sib?.voidBusinessDate).toBe("2026-05-12");
    expect(sib?.voidLocalId).toBe(row.localVoidId);
    expect(sib?.voidReason).toBe("salah input item");
  });

  it("trims a blank reason to null on both the outbox row and the optimistic sale mark", async () => {
    const db = await getDatabase();
    const sale = makeSale();
    await db.repos.pendingSales.enqueue(sale);

    const { row } = await enqueueVoid({
      saleId: "sale-server-id-xyz",
      localSaleId: sale.localSaleId,
      outletId: sale.outletId,
      managerStaffId: "33333333-3333-7000-8000-000000000003",
      managerPin: "9876",
      voidBusinessDate: "2026-05-12",
      reason: "   ",
      now: NOW,
    });

    expect(row.reason).toBeNull();
    const sib = await db.repos.pendingSales.getById(sale.localSaleId);
    expect(sib?.voidReason).toBeNull();
  });

  it("stamps `now()` once — the outbox row's voidedAt and the sale's voidedAt agree", async () => {
    const db = await getDatabase();
    const sale = makeSale();
    await db.repos.pendingSales.enqueue(sale);

    let calls = 0;
    const now = () => {
      calls += 1;
      // Different return value on the second call to catch double-calls.
      return new Date(calls === 1 ? "2026-05-12T09:30:00.000Z" : "2026-05-12T09:31:00.000Z");
    };

    const { row } = await enqueueVoid({
      saleId: "sale-server-id-xyz",
      localSaleId: sale.localSaleId,
      outletId: sale.outletId,
      managerStaffId: "33333333-3333-7000-8000-000000000003",
      managerPin: "9876",
      voidBusinessDate: "2026-05-12",
      now,
    });
    const sib = await db.repos.pendingSales.getById(sale.localSaleId);
    expect(sib?.voidedAt).toBe(row.voidedAt);
  });

  it("produces a uuidv7 localVoidId derived from the stamp millis", async () => {
    const db = await getDatabase();
    const sale = makeSale();
    await db.repos.pendingSales.enqueue(sale);

    const stamp = new Date("2026-05-12T09:30:00.000Z");
    const millis = stamp.getTime().toString(16).padStart(12, "0");

    const { row } = await enqueueVoid({
      saleId: "sale-server-id-xyz",
      localSaleId: sale.localSaleId,
      outletId: sale.outletId,
      managerStaffId: "33333333-3333-7000-8000-000000000003",
      managerPin: "9876",
      voidBusinessDate: "2026-05-12",
      now: () => stamp,
    });

    // First 12 hex digits of a uuidv7 are the unix-ms timestamp.
    expect(row.localVoidId.replace(/-/g, "").slice(0, 12)).toBe(millis);
  });
});
