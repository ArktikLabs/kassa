import { getDatabase, type Database } from "../../data/db/index.ts";
import type { ParkedSale, ShiftState } from "../../data/db/types.ts";
import { uuidv7 } from "../../lib/uuidv7.ts";
import type { CartState } from "../cart/reducer.ts";

/*
 * KASA-366 — orchestration for the parked-cart tray.
 *
 * Park snapshots the active cart, drops the row into Dexie, and the
 * caller resets the active cart to empty. Resume reads the row back,
 * deletes it, and the caller hydrates the active cart from the
 * returned `CartState`. Both ends keep the cart store on the UI side
 * so the reducer remains the single source of truth for in-memory
 * cart shape.
 *
 * Discard removes a row without touching the active cart — the
 * caller is expected to gate this behind the manager PIN.
 *
 * Every parked row is scoped to `(outletId, localShiftId)` so a parked
 * cart cannot leak across shifts. Callers that don't have an open
 * shift get a typed refusal instead of writing an orphan row.
 */

/** Maximum characters we'll persist for the clerk label, after trim. */
export const MAX_PARK_LABEL_LENGTH = 40;

export type ParkCartResult =
  | { kind: "ok"; row: ParkedSale }
  | { kind: "no_open_shift" }
  | { kind: "empty_cart" }
  | { kind: "blank_label" };

export interface ParkCartInput {
  label: string;
  cart: CartState;
  /** Override clock for tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Inject the database for tests; defaults to the singleton. */
  database?: Database;
}

function trimLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > MAX_PARK_LABEL_LENGTH) return trimmed.slice(0, MAX_PARK_LABEL_LENGTH);
  return trimmed;
}

async function resolveDb(injected?: Database): Promise<Database> {
  return injected ?? (await getDatabase());
}

async function getOpenShift(db: Database): Promise<ShiftState | null> {
  const row = await db.repos.shiftState.get();
  if (!row) return null;
  if (row.closedAt !== null) return null;
  return row;
}

export async function parkActiveCart(input: ParkCartInput): Promise<ParkCartResult> {
  const label = trimLabel(input.label);
  if (label.length === 0) return { kind: "blank_label" };
  if (input.cart.lines.length === 0) return { kind: "empty_cart" };

  const db = await resolveDb(input.database);
  const shift = await getOpenShift(db);
  if (!shift) return { kind: "no_open_shift" };

  const now = input.now ?? (() => new Date());
  const parkedAt = now().toISOString();
  const row: ParkedSale = {
    id: uuidv7(now().getTime()),
    outletId: shift.outletId,
    localShiftId: shift.localShiftId,
    cashierStaffId: shift.cashierStaffId,
    label,
    lines: input.cart.lines.map((l) => ({ ...l })),
    discountIdr: input.cart.discountIdr,
    parkedAt,
  };
  await db.repos.parkedSales.put(row);
  return { kind: "ok", row };
}

export type ResumeParkedResult =
  | { kind: "ok"; row: ParkedSale; cart: CartState }
  | { kind: "not_found" };

export interface ResumeParkedInput {
  id: string;
  database?: Database;
}

export async function resumeParkedCart(input: ResumeParkedInput): Promise<ResumeParkedResult> {
  const db = await resolveDb(input.database);
  const row = await db.repos.parkedSales.getById(input.id);
  if (!row) return { kind: "not_found" };
  await db.repos.parkedSales.delete(row.id);
  return {
    kind: "ok",
    row,
    cart: { lines: row.lines, discountIdr: row.discountIdr },
  };
}

export interface DiscardParkedInput {
  id: string;
  database?: Database;
}

export type DiscardParkedResult = { kind: "ok" } | { kind: "not_found" };

export async function discardParkedCart(input: DiscardParkedInput): Promise<DiscardParkedResult> {
  const db = await resolveDb(input.database);
  const existing = await db.repos.parkedSales.getById(input.id);
  if (!existing) return { kind: "not_found" };
  await db.repos.parkedSales.delete(input.id);
  return { kind: "ok" };
}

export interface ListParkedInput {
  database?: Database;
}

export async function listParkedForCurrentShift(
  input: ListParkedInput = {},
): Promise<readonly ParkedSale[]> {
  const db = await resolveDb(input.database);
  const shift = await getOpenShift(db);
  if (!shift) return [];
  return db.repos.parkedSales.listForShift(shift.outletId, shift.localShiftId);
}

export async function countParkedForCurrentShift(input: ListParkedInput = {}): Promise<number> {
  const db = await resolveDb(input.database);
  const shift = await getOpenShift(db);
  if (!shift) return 0;
  return db.repos.parkedSales.countForShift(shift.outletId, shift.localShiftId);
}

/**
 * Drop every parked row for the current open shift. Called from the
 * shift-close flow after the cashier confirms they want to discard the
 * parked tray. Returns the number of rows cleared so the UI can surface
 * a confirmation toast.
 */
export async function clearParkedForCurrentShift(input: ListParkedInput = {}): Promise<number> {
  const db = await resolveDb(input.database);
  const shift = await getOpenShift(db);
  if (!shift) return 0;
  return db.repos.parkedSales.clearForShift(shift.outletId, shift.localShiftId);
}
