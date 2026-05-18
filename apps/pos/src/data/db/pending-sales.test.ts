import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import { createRepos, type Repos } from "./index.ts";
import { type KassaDexie, openKassaDb } from "./schema.ts";
import type { NewPendingSale } from "./pending-sales.ts";

let dbCounter = 0;
function nextDbName(): string {
  dbCounter += 1;
  return `kassa-pos-pending-test-${dbCounter}-${Math.random().toString(36).slice(2, 10)}`;
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

function makeSale(overrides: Partial<NewPendingSale> & { localSaleId: string }): NewPendingSale {
  return {
    localSaleId: overrides.localSaleId,
    outletId: overrides.outletId ?? "outlet-a",
    clerkId: overrides.clerkId ?? "clerk-1",
    businessDate: overrides.businessDate ?? "2026-04-23",
    createdAt: overrides.createdAt ?? "2026-04-23T08:00:00.000Z",
    subtotalIdr: overrides.subtotalIdr ?? toRupiah(10_000),
    discountIdr: overrides.discountIdr ?? toRupiah(0),
    totalIdr: overrides.totalIdr ?? toRupiah(10_000),
    items: overrides.items ?? [
      {
        itemId: "item-1",
        bomId: null,
        quantity: 1,
        uomId: "uom-cup",
        unitPriceIdr: toRupiah(10_000),
        lineTotalIdr: toRupiah(10_000),
      },
    ],
    tenders: overrides.tenders ?? [
      { method: "cash", amountIdr: toRupiah(10_000), reference: null },
    ],
  };
}

describe("pendingSalesRepo.listRecentByOutlet", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("returns the requested outlet's sales newest-first", async () => {
    const repo = fixture.repos.pendingSales;
    await repo.enqueue(makeSale({ localSaleId: "sale-1", createdAt: "2026-04-23T08:00:00.000Z" }));
    await repo.enqueue(makeSale({ localSaleId: "sale-2", createdAt: "2026-04-23T09:30:00.000Z" }));
    await repo.enqueue(makeSale({ localSaleId: "sale-3", createdAt: "2026-04-23T11:15:00.000Z" }));

    const rows = await repo.listRecentByOutlet("outlet-a");
    expect(rows.map((r) => r.localSaleId)).toEqual(["sale-3", "sale-2", "sale-1"]);
  });

  it("filters out sales that belong to other outlets", async () => {
    const repo = fixture.repos.pendingSales;
    await repo.enqueue(
      makeSale({
        localSaleId: "outlet-a-sale",
        outletId: "outlet-a",
        createdAt: "2026-04-23T08:00:00.000Z",
      }),
    );
    await repo.enqueue(
      makeSale({
        localSaleId: "outlet-b-sale",
        outletId: "outlet-b",
        createdAt: "2026-04-23T09:00:00.000Z",
      }),
    );

    const rows = await repo.listRecentByOutlet("outlet-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.localSaleId).toBe("outlet-a-sale");
  });

  it("includes synced sales so reprints work after the outbox drains", async () => {
    const repo = fixture.repos.pendingSales;
    await repo.enqueue(
      makeSale({ localSaleId: "sale-synced", createdAt: "2026-04-23T08:00:00.000Z" }),
    );
    await repo.markSending("sale-synced", "2026-04-23T08:00:01.000Z");
    await repo.markSynced(
      "sale-synced",
      { name: "POS-SALE-0001", saleId: "00000000-0000-7000-8000-000000000001" },
      "2026-04-23T08:00:02.000Z",
    );

    const rows = await repo.listRecentByOutlet("outlet-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("synced");
    expect(rows[0]?.serverSaleName).toBe("POS-SALE-0001");
  });

  it("caps results at the configured limit", async () => {
    const repo = fixture.repos.pendingSales;
    for (let i = 0; i < 7; i += 1) {
      const padded = String(i).padStart(2, "0");
      await repo.enqueue(
        makeSale({
          localSaleId: `sale-${padded}`,
          createdAt: `2026-04-23T08:${padded}:00.000Z`,
        }),
      );
    }

    const rows = await repo.listRecentByOutlet("outlet-a", 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.localSaleId)).toEqual(["sale-06", "sale-05", "sale-04"]);
  });
});
