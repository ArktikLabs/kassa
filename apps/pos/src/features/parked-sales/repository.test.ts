import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import { createRepos, type Database } from "../../data/db/index.ts";
import { type KassaDexie, openKassaDb } from "../../data/db/schema.ts";
import type { ShiftState } from "../../data/db/types.ts";
import type { CartState } from "../cart/reducer.ts";
import {
  clearParkedForCurrentShift,
  countParkedForCurrentShift,
  discardParkedCart,
  listParkedForCurrentShift,
  MAX_PARK_LABEL_LENGTH,
  parkActiveCart,
  resumeParkedCart,
} from "./repository.ts";

let dbCounter = 0;
function nextDbName(): string {
  dbCounter += 1;
  return `kassa-parked-feat-${dbCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Fixture {
  name: string;
  db: KassaDexie;
  database: Database;
}

async function setupFixture(): Promise<Fixture> {
  const name = nextDbName();
  const db = await openKassaDb(name);
  const repos = createRepos(db);
  const database: Database = {
    db,
    repos,
    close: () => db.close(),
  };
  return { name, db, database };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  fixture.db.close();
  await Dexie.delete(fixture.name);
}

async function seedOpenShift(
  fixture: Fixture,
  overrides: Partial<Omit<ShiftState, "id">> = {},
): Promise<void> {
  await fixture.database.repos.shiftState.put({
    localShiftId: overrides.localShiftId ?? "shift-A",
    outletId: overrides.outletId ?? "outlet-A",
    cashierStaffId: overrides.cashierStaffId ?? "staff-1",
    businessDate: overrides.businessDate ?? "2026-05-29",
    openShiftId: overrides.openShiftId ?? "open-1",
    openedAt: overrides.openedAt ?? "2026-05-29T03:00:00.000Z",
    openingFloatIdr: overrides.openingFloatIdr ?? 100_000,
    serverShiftId: overrides.serverShiftId ?? null,
    closedAt: overrides.closedAt ?? null,
  });
}

function makeCart(): CartState {
  return {
    lines: [
      {
        itemId: "item-kopi",
        name: "Kopi Susu",
        unitPriceIdr: toRupiah(18000),
        quantity: 2,
        lineTotalIdr: toRupiah(36000),
      },
      {
        itemId: "item-roti",
        name: "Roti Bakar",
        unitPriceIdr: toRupiah(12500),
        quantity: 1,
        lineTotalIdr: toRupiah(12500),
      },
    ],
    discountIdr: toRupiah(1500),
  };
}

describe("parkActiveCart", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("rejects a blank label", async () => {
    await seedOpenShift(fixture);
    const res = await parkActiveCart({
      database: fixture.database,
      label: "   ",
      cart: makeCart(),
    });
    expect(res.kind).toBe("blank_label");
  });

  it("rejects an empty cart", async () => {
    await seedOpenShift(fixture);
    const res = await parkActiveCart({
      database: fixture.database,
      label: "Meja 3",
      cart: { lines: [], discountIdr: toRupiah(0) },
    });
    expect(res.kind).toBe("empty_cart");
  });

  it("refuses when no shift is open", async () => {
    const res = await parkActiveCart({
      database: fixture.database,
      label: "Meja 3",
      cart: makeCart(),
    });
    expect(res.kind).toBe("no_open_shift");
  });

  it("trims the label and persists the row scoped to the active shift", async () => {
    await seedOpenShift(fixture, { localShiftId: "shift-X", outletId: "outlet-Z" });
    const res = await parkActiveCart({
      database: fixture.database,
      label: "  Meja 3  ",
      cart: makeCart(),
      now: () => new Date("2026-05-29T04:00:00.000Z"),
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.row.label).toBe("Meja 3");
    expect(res.row.outletId).toBe("outlet-Z");
    expect(res.row.localShiftId).toBe("shift-X");
    expect(res.row.parkedAt).toBe("2026-05-29T04:00:00.000Z");
    expect(res.row.lines).toHaveLength(2);
    expect(res.row.discountIdr).toBe(1500);
  });

  it("truncates an over-long label to the cap", async () => {
    await seedOpenShift(fixture);
    const longLabel = "x".repeat(MAX_PARK_LABEL_LENGTH + 25);
    const res = await parkActiveCart({
      database: fixture.database,
      label: longLabel,
      cart: makeCart(),
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.row.label).toHaveLength(MAX_PARK_LABEL_LENGTH);
  });
});

describe("listParkedForCurrentShift / countParkedForCurrentShift", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("returns an empty list when no shift is open", async () => {
    await expect(listParkedForCurrentShift({ database: fixture.database })).resolves.toEqual([]);
    await expect(countParkedForCurrentShift({ database: fixture.database })).resolves.toBe(0);
  });

  it("returns only the rows for the current open shift, newest first", async () => {
    await seedOpenShift(fixture, { localShiftId: "shift-current" });
    // Two parked rows in the current shift, one in a previous shift.
    let clock = new Date("2026-05-29T04:00:00.000Z").getTime();
    const tick = () => {
      clock += 1000;
      return new Date(clock);
    };
    await parkActiveCart({
      database: fixture.database,
      label: "Meja 1",
      cart: makeCart(),
      now: tick,
    });
    await parkActiveCart({
      database: fixture.database,
      label: "Meja 2",
      cart: makeCart(),
      now: tick,
    });
    // Drop a previous-shift row directly into the table.
    await fixture.database.repos.parkedSales.put({
      id: "old-row",
      outletId: "outlet-A",
      localShiftId: "shift-yesterday",
      cashierStaffId: "staff-1",
      label: "Stale",
      lines: [],
      discountIdr: toRupiah(0),
      parkedAt: "2026-05-28T22:00:00.000Z",
    });

    const list = await listParkedForCurrentShift({ database: fixture.database });
    expect(list.map((r) => r.label)).toEqual(["Meja 2", "Meja 1"]);
    await expect(countParkedForCurrentShift({ database: fixture.database })).resolves.toBe(2);
  });
});

describe("resumeParkedCart", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("returns not_found for an unknown id", async () => {
    const res = await resumeParkedCart({ database: fixture.database, id: "nope" });
    expect(res.kind).toBe("not_found");
  });

  it("returns the cart state and deletes the row", async () => {
    await seedOpenShift(fixture);
    const parked = await parkActiveCart({
      database: fixture.database,
      label: "Meja 3",
      cart: makeCart(),
    });
    if (parked.kind !== "ok") throw new Error("seed failed");

    const res = await resumeParkedCart({ database: fixture.database, id: parked.row.id });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.cart.lines).toHaveLength(2);
    expect(res.cart.lines[0]?.quantity).toBe(2);
    expect(res.cart.discountIdr).toBe(1500);

    await expect(
      fixture.database.repos.parkedSales.getById(parked.row.id),
    ).resolves.toBeUndefined();
  });
});

describe("discardParkedCart", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("returns not_found for an unknown id without throwing", async () => {
    await expect(discardParkedCart({ database: fixture.database, id: "nope" })).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("removes only the targeted row", async () => {
    await seedOpenShift(fixture);
    const a = await parkActiveCart({
      database: fixture.database,
      label: "A",
      cart: makeCart(),
    });
    const b = await parkActiveCart({
      database: fixture.database,
      label: "B",
      cart: makeCart(),
    });
    if (a.kind !== "ok" || b.kind !== "ok") throw new Error("seed failed");

    const res = await discardParkedCart({ database: fixture.database, id: a.row.id });
    expect(res.kind).toBe("ok");
    const remaining = await listParkedForCurrentShift({ database: fixture.database });
    expect(remaining.map((r) => r.id)).toEqual([b.row.id]);
  });
});

describe("clearParkedForCurrentShift", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("returns 0 when no shift is open", async () => {
    await expect(clearParkedForCurrentShift({ database: fixture.database })).resolves.toBe(0);
  });

  it("returns the cleared count and leaves previous-shift rows alone", async () => {
    await seedOpenShift(fixture, { localShiftId: "shift-current" });
    await parkActiveCart({ database: fixture.database, label: "A", cart: makeCart() });
    await parkActiveCart({ database: fixture.database, label: "B", cart: makeCart() });
    await fixture.database.repos.parkedSales.put({
      id: "old-row",
      outletId: "outlet-A",
      localShiftId: "shift-yesterday",
      cashierStaffId: "staff-1",
      label: "Stale",
      lines: [],
      discountIdr: toRupiah(0),
      parkedAt: "2026-05-28T22:00:00.000Z",
    });

    const n = await clearParkedForCurrentShift({ database: fixture.database });
    expect(n).toBe(2);
    await expect(fixture.database.repos.parkedSales.getById("old-row")).resolves.toBeDefined();
  });
});
