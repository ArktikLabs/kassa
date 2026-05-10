import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { _resetDatabaseSingletonForTest, DB_NAME } from "../../data/db/index.ts";
import { enqueueCloseShift, enqueueOpenShift, getCurrentShift } from "./repository.ts";

const NOW = () => new Date("2026-04-23T09:00:00.000Z");

beforeEach(async () => {
  _resetDatabaseSingletonForTest();
  await Dexie.delete(DB_NAME);
});

afterEach(async () => {
  _resetDatabaseSingletonForTest();
  await Dexie.delete(DB_NAME);
});

describe("enqueueOpenShift", () => {
  it("stamps both an outbox event and the shift_state singleton", async () => {
    const result = await enqueueOpenShift({
      outletId: "11111111-1111-1111-1111-111111111111",
      cashierStaffId: "22222222-2222-2222-2222-222222222222",
      businessDate: "2026-04-23",
      openingFloatIdr: 100_000,
      now: NOW,
    });
    expect(result.event.kind).toBe("open");
    expect(result.event.openingFloatIdr).toBe(100_000);
    expect(result.event.status).toBe("queued");
    expect(result.state.openShiftId).toBe(result.event.openShiftId);
    expect(result.state.closedAt).toBe(null);

    const current = await getCurrentShift();
    expect(current?.openShiftId).toBe(result.state.openShiftId);
  });
});

describe("enqueueCloseShift", () => {
  it("requires an open shift", async () => {
    const result = await enqueueCloseShift({ countedCashIdr: 100_000, now: NOW });
    expect(result.kind).toBe("no_open_shift");
  });

  it("enqueues a close event keyed off the open shift and locally marks closed", async () => {
    const open = await enqueueOpenShift({
      outletId: "11111111-1111-1111-1111-111111111111",
      cashierStaffId: "22222222-2222-2222-2222-222222222222",
      businessDate: "2026-04-23",
      openingFloatIdr: 100_000,
      now: NOW,
    });
    const close = await enqueueCloseShift({ countedCashIdr: 175_000, now: NOW });
    expect(close.kind).toBe("ok");
    if (close.kind !== "ok") return;
    expect(close.event.kind).toBe("close");
    expect(close.event.openShiftId).toBe(open.event.openShiftId);
    expect(close.event.countedCashIdr).toBe(175_000);
    expect(close.state.closedAt).not.toBe(null);
    // Once the local row is marked closed, getCurrentShift() returns null
    // so the boot guard routes the cashier back to /shift/open.
    const current = await getCurrentShift();
    expect(current).toBe(null);
  });

  it("refuses a second close after the local mark", async () => {
    await enqueueOpenShift({
      outletId: "11111111-1111-1111-1111-111111111111",
      cashierStaffId: "22222222-2222-2222-2222-222222222222",
      businessDate: "2026-04-23",
      openingFloatIdr: 100_000,
      now: NOW,
    });
    await enqueueCloseShift({ countedCashIdr: 100_000, now: NOW });
    const second = await enqueueCloseShift({ countedCashIdr: 99_000, now: NOW });
    expect(second.kind).toBe("no_open_shift");
  });
});
