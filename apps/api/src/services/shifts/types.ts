/*
 * Domain types for the cashier shift open/close pipeline (KASA-235).
 *
 * The service works in memory today; a Postgres repository (KASA-21) will
 * drop in behind the `ShiftsRepository` interface using the canonical
 * drizzle table under `src/db/schema/shifts.ts`.
 */

export type ShiftStatus = "open" | "closed";

export interface ShiftRecord {
  id: string;
  merchantId: string;
  outletId: string;
  cashierStaffId: string;
  businessDate: string; // YYYY-MM-DD, outlet-local
  status: ShiftStatus;
  openShiftId: string;
  openedAt: string; // ISO-8601 with offset
  openingFloatIdr: number;
  closeShiftId: string | null;
  closedAt: string | null;
  countedCashIdr: number | null;
  expectedCashIdr: number | null;
  varianceIdr: number | null;
}
