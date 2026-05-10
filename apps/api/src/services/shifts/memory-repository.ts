import type { ShiftsRepository } from "./repository.js";
import type { ShiftRecord } from "./types.js";

/**
 * Process-local, unsynchronised. Fine for single-instance dev + tests; the
 * Postgres impl in KASA-21 will swap behind the same interface.
 */
export class InMemoryShiftsRepository implements ShiftsRepository {
  private readonly byId = new Map<string, ShiftRecord>();
  private readonly byOpenKey = new Map<string, string>();
  private readonly byCloseKey = new Map<string, string>();

  private static openKey(merchantId: string, openShiftId: string): string {
    return `${merchantId}::${openShiftId}`;
  }

  private static closeKey(merchantId: string, closeShiftId: string): string {
    return `${merchantId}::${closeShiftId}`;
  }

  async findShiftForBusinessDate(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<ShiftRecord | null> {
    let latest: ShiftRecord | null = null;
    for (const row of this.byId.values()) {
      if (
        row.merchantId === input.merchantId &&
        row.outletId === input.outletId &&
        row.businessDate === input.businessDate
      ) {
        if (!latest || row.openedAt > latest.openedAt) latest = row;
      }
    }
    return latest;
  }

  async findByOpenShiftId(input: {
    merchantId: string;
    openShiftId: string;
  }): Promise<ShiftRecord | null> {
    const id = this.byOpenKey.get(
      InMemoryShiftsRepository.openKey(input.merchantId, input.openShiftId),
    );
    if (!id) return null;
    return this.byId.get(id) ?? null;
  }

  async findByCloseShiftId(input: {
    merchantId: string;
    closeShiftId: string;
  }): Promise<ShiftRecord | null> {
    const id = this.byCloseKey.get(
      InMemoryShiftsRepository.closeKey(input.merchantId, input.closeShiftId),
    );
    if (!id) return null;
    return this.byId.get(id) ?? null;
  }

  async findOpenShiftForCashier(input: {
    merchantId: string;
    outletId: string;
    cashierStaffId: string;
  }): Promise<ShiftRecord | null> {
    let latest: ShiftRecord | null = null;
    for (const row of this.byId.values()) {
      if (
        row.merchantId === input.merchantId &&
        row.outletId === input.outletId &&
        row.cashierStaffId === input.cashierStaffId &&
        row.status === "open"
      ) {
        if (!latest || row.openedAt > latest.openedAt) latest = row;
      }
    }
    return latest;
  }

  async insertOpen(record: ShiftRecord): Promise<ShiftRecord> {
    const openKey = InMemoryShiftsRepository.openKey(record.merchantId, record.openShiftId);
    if (this.byOpenKey.has(openKey)) {
      // The service guards against this; a race on the single-threaded JS
      // loop is unreachable, but treat it as a programmer error if it ever
      // does fire.
      throw new Error(`Shift with openShiftId ${record.openShiftId} already exists`);
    }
    const stored: ShiftRecord = { ...record };
    this.byId.set(stored.id, stored);
    this.byOpenKey.set(openKey, stored.id);
    return stored;
  }

  async recordClose(input: {
    openShiftId: string;
    merchantId: string;
    closeShiftId: string;
    closedAt: string;
    countedCashIdr: number;
    expectedCashIdr: number;
    varianceIdr: number;
  }): Promise<ShiftRecord> {
    const id = this.byOpenKey.get(
      InMemoryShiftsRepository.openKey(input.merchantId, input.openShiftId),
    );
    if (!id) throw new Error(`No open shift for openShiftId ${input.openShiftId}`);
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`Shift ${id} disappeared`);
    if (existing.status === "closed") {
      throw new Error(`Shift ${id} already closed`);
    }
    const updated: ShiftRecord = {
      ...existing,
      status: "closed",
      closeShiftId: input.closeShiftId,
      closedAt: input.closedAt,
      countedCashIdr: input.countedCashIdr,
      expectedCashIdr: input.expectedCashIdr,
      varianceIdr: input.varianceIdr,
    };
    this.byId.set(id, updated);
    this.byCloseKey.set(
      InMemoryShiftsRepository.closeKey(input.merchantId, input.closeShiftId),
      id,
    );
    return updated;
  }
}
