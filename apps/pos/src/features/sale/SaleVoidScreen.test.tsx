import { describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import type { PendingSale, ShiftState } from "../../data/db/types.ts";
import { computeEligibility, planVoidFollowUp } from "./SaleVoidScreen.tsx";
import type { VoidSaleApiResult } from "./voidApi.ts";

function makeSale(overrides: Partial<PendingSale> = {}): PendingSale {
  return {
    localSaleId: overrides.localSaleId ?? "sale-local-1",
    outletId: overrides.outletId ?? "outlet-a",
    clerkId: overrides.clerkId ?? "device-1",
    businessDate: overrides.businessDate ?? "2026-05-12",
    createdAt: overrides.createdAt ?? "2026-05-12T08:00:00.000Z",
    subtotalIdr: overrides.subtotalIdr ?? toRupiah(50_000),
    discountIdr: overrides.discountIdr ?? toRupiah(0),
    totalIdr: overrides.totalIdr ?? toRupiah(50_000),
    items: overrides.items ?? [],
    tenders: overrides.tenders ?? [],
    status: overrides.status ?? "synced",
    attempts: overrides.attempts ?? 0,
    lastError: overrides.lastError ?? null,
    lastAttemptAt: overrides.lastAttemptAt ?? null,
    serverSaleName: "serverSaleName" in overrides ? (overrides.serverSaleName ?? null) : "SALE-00001",
    serverSaleId: "serverSaleId" in overrides ? (overrides.serverSaleId ?? null) : "sale-server-uuid",
    voidedAt: overrides.voidedAt ?? null,
    voidBusinessDate: overrides.voidBusinessDate ?? null,
    voidReason: overrides.voidReason ?? null,
    voidLocalId: overrides.voidLocalId ?? null,
  };
}

function makeShift(overrides: Partial<ShiftState> = {}): ShiftState {
  return {
    id: "singleton",
    localShiftId: overrides.localShiftId ?? "shift-local-1",
    outletId: overrides.outletId ?? "outlet-a",
    cashierStaffId: overrides.cashierStaffId ?? "staff-1",
    businessDate: overrides.businessDate ?? "2026-05-12",
    openShiftId: overrides.openShiftId ?? "shift-local-1",
    openedAt: overrides.openedAt ?? "2026-05-12T08:00:00.000Z",
    openingFloatIdr: overrides.openingFloatIdr ?? 100_000,
    serverShiftId: overrides.serverShiftId ?? null,
    closedAt: overrides.closedAt ?? null,
  };
}

describe("computeEligibility", () => {
  it("ok when the sale is unsynced-but-pending? — no: requires serverSaleId", () => {
    const sale = makeSale({ serverSaleId: null });
    const shift = makeShift();
    expect(computeEligibility(sale, shift)).toEqual({
      kind: "blocked",
      messageId: "void.error.unsynced",
    });
  });

  it("ok when the sale has a serverSaleId, an open shift exists, and businessDate matches", () => {
    expect(computeEligibility(makeSale(), makeShift())).toEqual({ kind: "ok" });
  });

  it("already_voided takes precedence over every other check", () => {
    const sale = makeSale({
      voidedAt: "2026-05-12T09:00:00.000Z",
      // Even with these other blockers present, voidedAt wins.
      serverSaleId: null,
      businessDate: "2026-05-11",
    });
    expect(computeEligibility(sale, null)).toEqual({
      kind: "blocked",
      messageId: "void.error.already_voided",
    });
  });

  it("no_open_shift when shift is null", () => {
    expect(computeEligibility(makeSale(), null)).toEqual({
      kind: "blocked",
      messageId: "void.error.no_open_shift",
    });
  });

  it("outside_shift when sale.businessDate ≠ shift.businessDate", () => {
    const sale = makeSale({ businessDate: "2026-05-11" });
    const shift = makeShift({ businessDate: "2026-05-12" });
    expect(computeEligibility(sale, shift)).toEqual({
      kind: "blocked",
      messageId: "void.error.outside_shift",
    });
  });

  it("unsynced when serverSaleId is missing", () => {
    const sale = makeSale({ serverSaleId: null });
    expect(computeEligibility(sale, makeShift())).toEqual({
      kind: "blocked",
      messageId: "void.error.unsynced",
    });
  });

  it("also unsynced when serverSaleId is undefined (pre-KASA-236 outbox row)", () => {
    const sale = makeSale();
    delete (sale as { serverSaleId?: string | null }).serverSaleId;
    expect(computeEligibility(sale, makeShift())).toEqual({
      kind: "blocked",
      messageId: "void.error.unsynced",
    });
  });
});

describe("planVoidFollowUp (toast path dispatcher)", () => {
  it("synced → success toast, mark_synced, navigate to receipt, trigger push", () => {
    const result: VoidSaleApiResult = {
      kind: "synced",
      response: {
        id: "v",
        saleId: "s",
        voidedAt: "2026-05-12T09:30:00.000Z",
      } as VoidSaleApiResult extends { kind: "synced"; response: infer R } ? R : never,
    };
    const plan = planVoidFollowUp(result);
    expect(plan).toEqual({
      outboxAction: "mark_synced",
      toast: { id: "void.toast.success", variant: "success" },
      navigateToReceipt: true,
      triggerPush: true,
    });
  });

  it("manager_pin_required → error toast, rollback, no navigate, sets error", () => {
    const plan = planVoidFollowUp({
      kind: "manager_pin_required",
      status: 403,
      message: "wrong PIN",
    });
    expect(plan).toMatchObject({
      outboxAction: "rollback_and_mark_needs_attention",
      outboxError: "wrong PIN",
      toast: { id: "void.toast.manager_pin_required", variant: "error" },
      navigateToReceipt: false,
      errorMessage: { id: "void.error.manager_pin_required" },
    });
  });

  it("outside_open_shift → error toast, rollback, no navigate, sets error", () => {
    const plan = planVoidFollowUp({
      kind: "outside_open_shift",
      status: 422,
      message: "shift mismatch",
    });
    expect(plan).toMatchObject({
      outboxAction: "rollback_and_mark_needs_attention",
      outboxError: "shift mismatch",
      toast: { id: "void.toast.outside_shift", variant: "error" },
      navigateToReceipt: false,
      errorMessage: { id: "void.error.outside_shift" },
    });
  });

  it("already_voided → info toast, mark_synced (keep optimistic mark), navigate", () => {
    // The local mark matches the server's outcome — no rollback. The
    // outbox row closes so the drain doesn't replay it.
    const plan = planVoidFollowUp({
      kind: "already_voided",
      status: 422,
      message: "already voided",
    });
    expect(plan).toMatchObject({
      outboxAction: "mark_synced",
      toast: { id: "void.error.already_voided", variant: "info" },
      navigateToReceipt: true,
    });
    // No triggerPush — there's no row to drain anymore.
    expect(plan.triggerPush).toBeFalsy();
  });

  it("rejected → raw error message in toast + error banner, rollback", () => {
    const plan = planVoidFollowUp({
      kind: "rejected",
      status: 422,
      code: "some_other_thing",
      message: "raw server message",
    });
    expect(plan).toMatchObject({
      outboxAction: "rollback_and_mark_needs_attention",
      outboxError: "raw server message",
      toast: { literal: "raw server message", variant: "error" },
      navigateToReceipt: false,
      errorMessage: { literal: "raw server message" },
    });
  });

  it("retriable → info toast, leave queued, navigate, trigger push", () => {
    const plan = planVoidFollowUp({
      kind: "retriable",
      status: 503,
      message: "upstream",
    });
    expect(plan).toMatchObject({
      outboxAction: "leave_queued",
      toast: { id: "void.toast.queued", variant: "info" },
      navigateToReceipt: true,
      triggerPush: true,
    });
  });

  it("offline → info toast, leave queued, navigate, trigger push", () => {
    const plan = planVoidFollowUp({ kind: "offline", reason: "network" });
    expect(plan).toMatchObject({
      outboxAction: "leave_queued",
      toast: { id: "void.toast.queued", variant: "info" },
      navigateToReceipt: true,
      triggerPush: true,
    });
  });
});
