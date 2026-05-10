import { uuidv7 } from "../../lib/uuidv7.ts";
import { getDatabase } from "../../data/db/index.ts";
import type { PendingShiftEvent, ShiftState } from "../../data/db/types.ts";

/*
 * High-level orchestration for the cashier shift lifecycle (KASA-235).
 *
 * The boot guard reads `shift_state` to decide whether to redirect to
 * `/shift/open`; the open and close routes call into this module to
 * stamp the local outbox + state in one place. The sync runner's
 * `pushShiftEvents` drain owns the network half of the loop.
 */

export interface OpenShiftDraft {
  outletId: string;
  cashierStaffId: string;
  businessDate: string;
  openingFloatIdr: number;
  /** Override clock for tests; defaults to `new Date()`. */
  now?: () => Date;
}

export interface OpenShiftResult {
  state: ShiftState;
  event: PendingShiftEvent;
}

export async function enqueueOpenShift(input: OpenShiftDraft): Promise<OpenShiftResult> {
  const database = await getDatabase();
  const now = input.now ?? (() => new Date());
  const localShiftId = uuidv7(now().getTime());
  const openShiftId = uuidv7(now().getTime());
  const occurredAt = now().toISOString();

  const event = await database.repos.pendingShiftEvents.enqueue({
    eventId: openShiftId,
    localShiftId,
    kind: "open",
    outletId: input.outletId,
    cashierStaffId: input.cashierStaffId,
    businessDate: input.businessDate,
    createdAt: occurredAt,
    openShiftId,
    closeShiftId: null,
    occurredAt,
    openingFloatIdr: input.openingFloatIdr,
  });

  const state = await database.repos.shiftState.put({
    localShiftId,
    outletId: input.outletId,
    cashierStaffId: input.cashierStaffId,
    businessDate: input.businessDate,
    openShiftId,
    openedAt: occurredAt,
    openingFloatIdr: input.openingFloatIdr,
    serverShiftId: null,
    closedAt: null,
  });

  return { event, state };
}

export interface CloseShiftDraft {
  countedCashIdr: number;
  /** Override clock for tests; defaults to `new Date()`. */
  now?: () => Date;
}

export type CloseShiftResult =
  | { kind: "ok"; state: ShiftState; event: PendingShiftEvent }
  | { kind: "no_open_shift" };

export async function enqueueCloseShift(input: CloseShiftDraft): Promise<CloseShiftResult> {
  const database = await getDatabase();
  const state = await database.repos.shiftState.get();
  if (!state || state.closedAt !== null) {
    return { kind: "no_open_shift" };
  }
  const now = input.now ?? (() => new Date());
  const closeShiftId = uuidv7(now().getTime());
  const occurredAt = now().toISOString();

  const event = await database.repos.pendingShiftEvents.enqueue({
    eventId: closeShiftId,
    localShiftId: state.localShiftId,
    kind: "close",
    outletId: state.outletId,
    cashierStaffId: state.cashierStaffId,
    businessDate: state.businessDate,
    createdAt: occurredAt,
    openShiftId: state.openShiftId,
    closeShiftId,
    occurredAt,
    countedCashIdr: input.countedCashIdr,
  });
  await database.repos.shiftState.markClosedLocally(occurredAt);
  const updated = await database.repos.shiftState.get();
  return { kind: "ok", state: updated as ShiftState, event };
}

/**
 * Read the open-shift singleton. Returns null if no open shift exists
 * locally (either none was ever opened, or the close was acknowledged
 * and the singleton was cleared).
 */
export async function getCurrentShift(): Promise<ShiftState | null> {
  const database = await getDatabase();
  const row = await database.repos.shiftState.get();
  if (!row) return null;
  if (row.closedAt !== null) return null;
  return row;
}
