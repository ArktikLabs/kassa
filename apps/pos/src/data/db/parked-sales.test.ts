import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import { createRepos, type Repos } from "./index.ts";
import { type KassaDexie, openKassaDb } from "./schema.ts";
import type { ParkedSale } from "./types.ts";

let dbCounter = 0;
function nextDbName(): string {
  dbCounter += 1;
  return `kassa-parked-test-${dbCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Fixture {
  name: string;
  db: KassaDexie;
  repos: Repos;
}

async function setupFixture(): Promise<Fixture> {
  const name = nextDbName();
  const db = await openKassaDb(name);
  return { name, db, repos: createRepos(db) };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  fixture.db.close();
  await Dexie.delete(fixture.name);
}

function makeParked(overrides: Partial<ParkedSale> = {}): ParkedSale {
  return {
    id: overrides.id ?? "parked-1",
    outletId: overrides.outletId ?? "outlet-A",
    localShiftId: overrides.localShiftId ?? "shift-1",
    cashierStaffId: overrides.cashierStaffId ?? "staff-1",
    label: overrides.label ?? "Meja 3",
    lines: overrides.lines ?? [
      {
        itemId: "item-kopi",
        name: "Kopi Susu",
        unitPriceIdr: toRupiah(18000),
        quantity: 2,
        lineTotalIdr: toRupiah(36000),
      },
    ],
    discountIdr: overrides.discountIdr ?? toRupiah(0),
    parkedAt: overrides.parkedAt ?? "2026-05-29T04:00:00.000Z",
  };
}

describe("parkedSalesRepo", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("round-trips a parked cart by id", async () => {
    const row = makeParked();
    await fixture.repos.parkedSales.put(row);
    const fetched = await fixture.repos.parkedSales.getById(row.id);
    expect(fetched?.label).toBe("Meja 3");
    expect(fetched?.lines[0]?.quantity).toBe(2);
  });

  it("listForShift returns only the (outlet, shift) rows, newest first", async () => {
    await fixture.repos.parkedSales.put(
      makeParked({ id: "p1", label: "Meja 1", parkedAt: "2026-05-29T04:00:00.000Z" }),
    );
    await fixture.repos.parkedSales.put(
      makeParked({ id: "p2", label: "Meja 2", parkedAt: "2026-05-29T04:05:00.000Z" }),
    );
    // Different outlet — must be excluded.
    await fixture.repos.parkedSales.put(makeParked({ id: "p3", outletId: "outlet-B" }));
    // Different shift — must be excluded.
    await fixture.repos.parkedSales.put(makeParked({ id: "p4", localShiftId: "shift-99" }));

    const rows = await fixture.repos.parkedSales.listForShift("outlet-A", "shift-1");
    expect(rows.map((r) => r.id)).toEqual(["p2", "p1"]);
  });

  it("countForShift matches listForShift length", async () => {
    await fixture.repos.parkedSales.put(makeParked({ id: "p1" }));
    await fixture.repos.parkedSales.put(makeParked({ id: "p2" }));
    await fixture.repos.parkedSales.put(makeParked({ id: "p3", localShiftId: "shift-other" }));

    const n = await fixture.repos.parkedSales.countForShift("outlet-A", "shift-1");
    expect(n).toBe(2);
  });

  it("delete removes a single row", async () => {
    await fixture.repos.parkedSales.put(makeParked({ id: "p1" }));
    await fixture.repos.parkedSales.put(makeParked({ id: "p2" }));
    await fixture.repos.parkedSales.delete("p1");
    const rows = await fixture.repos.parkedSales.listForShift("outlet-A", "shift-1");
    expect(rows.map((r) => r.id)).toEqual(["p2"]);
  });

  it("clearForShift removes only matching (outlet, shift) rows and returns the count", async () => {
    await fixture.repos.parkedSales.put(makeParked({ id: "p1" }));
    await fixture.repos.parkedSales.put(makeParked({ id: "p2" }));
    await fixture.repos.parkedSales.put(makeParked({ id: "p3", localShiftId: "shift-99" }));
    await fixture.repos.parkedSales.put(makeParked({ id: "p4", outletId: "outlet-B" }));

    const cleared = await fixture.repos.parkedSales.clearForShift("outlet-A", "shift-1");
    expect(cleared).toBe(2);
    await expect(fixture.repos.parkedSales.countForShift("outlet-A", "shift-1")).resolves.toBe(0);
    // The unrelated rows remain.
    await expect(fixture.repos.parkedSales.getById("p3")).resolves.toBeDefined();
    await expect(fixture.repos.parkedSales.getById("p4")).resolves.toBeDefined();
  });

  it("clearForShift on an empty tray returns 0 without throwing", async () => {
    await expect(fixture.repos.parkedSales.clearForShift("outlet-A", "shift-1")).resolves.toBe(0);
  });
});
