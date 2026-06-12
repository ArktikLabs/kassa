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

describe("pendingSalesRepo.findByReceiptCode (KASA-369)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("matches the last-six tail of localSaleId, case-insensitively", async () => {
    const repo = fixture.repos.pendingSales;
    await repo.enqueue(makeSale({ localSaleId: "018f9c1a-4b2e-7c00-b000-000000abc123" }));
    await repo.enqueue(makeSale({ localSaleId: "018f9c1a-4b2e-7c00-b000-000000def456" }));

    const hit = await repo.findByReceiptCode("outlet-a", "abc123");
    expect(hit?.localSaleId).toBe("018f9c1a-4b2e-7c00-b000-000000abc123");
  });

  it("scopes by outletId so multi-outlet devices never cross tenants", async () => {
    const repo = fixture.repos.pendingSales;
    await repo.enqueue(
      makeSale({ localSaleId: "018f9c1a-4b2e-7c00-b000-000000abc123", outletId: "outlet-a" }),
    );
    await repo.enqueue(
      makeSale({ localSaleId: "018f9c1a-4b2e-7c00-b000-999999abc123", outletId: "outlet-b" }),
    );

    const hitA = await repo.findByReceiptCode("outlet-a", "ABC123");
    expect(hitA?.outletId).toBe("outlet-a");
    const hitB = await repo.findByReceiptCode("outlet-b", "ABC123");
    expect(hitB?.outletId).toBe("outlet-b");
  });

  it("returns null when no sale matches", async () => {
    const repo = fixture.repos.pendingSales;
    await repo.enqueue(makeSale({ localSaleId: "018f9c1a-4b2e-7c00-b000-000000abc123" }));
    expect(await repo.findByReceiptCode("outlet-a", "999999")).toBeNull();
  });
});

describe("pendingSalesRepo.upsertSyncedFromRemote (KASA-370)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("hydrates a cross-device sale as `synced` with server identifiers", async () => {
    const repo = fixture.repos.pendingSales;
    const row = await repo.upsertSyncedFromRemote({
      serverSaleId: "server-sale-xyz",
      serverSaleName: "SALE-9001",
      localSaleId: "018f9c1a-4b2e-7c00-b000-000000cafe01",
      outletId: "outlet-a",
      clerkId: "kitchen-clerk",
      businessDate: "2026-04-23",
      createdAt: "2026-04-23T08:00:00.000Z",
      subtotalIdr: toRupiah(40_000),
      discountIdr: toRupiah(0),
      totalIdr: toRupiah(40_000),
      taxIdr: toRupiah(0),
      items: [
        {
          itemId: "item-1",
          bomId: null,
          quantity: 2,
          uomId: "uom-cup",
          unitPriceIdr: toRupiah(20_000),
          lineTotalIdr: toRupiah(40_000),
        },
      ],
      tenders: [{ method: "cash", amountIdr: toRupiah(40_000), reference: null }],
      voidedAt: null,
      voidBusinessDate: null,
      voidReason: null,
      voidLocalId: null,
      hydratedAt: "2026-04-23T08:10:00.000Z",
    });
    expect(row.status).toBe("synced");
    expect(row.serverSaleId).toBe("server-sale-xyz");
    expect(row.serverSaleName).toBe("SALE-9001");
    // Reading back through getById proves the row was actually persisted.
    const persisted = await repo.getById("018f9c1a-4b2e-7c00-b000-000000cafe01");
    expect(persisted?.status).toBe("synced");
    expect(persisted?.clerkId).toBe("kitchen-clerk");
  });

  it("propagates the void lifecycle from the server response", async () => {
    const repo = fixture.repos.pendingSales;
    const row = await repo.upsertSyncedFromRemote({
      serverSaleId: "server-sale-void",
      serverSaleName: "SALE-9002",
      localSaleId: "018f9c1a-4b2e-7c00-b000-000000beef02",
      outletId: "outlet-a",
      clerkId: "kitchen-clerk",
      businessDate: "2026-04-23",
      createdAt: "2026-04-23T08:00:00.000Z",
      subtotalIdr: toRupiah(25_000),
      discountIdr: toRupiah(0),
      totalIdr: toRupiah(25_000),
      items: [
        {
          itemId: "item-1",
          bomId: null,
          quantity: 1,
          uomId: "uom-cup",
          unitPriceIdr: toRupiah(25_000),
          lineTotalIdr: toRupiah(25_000),
        },
      ],
      tenders: [{ method: "cash", amountIdr: toRupiah(25_000), reference: null }],
      voidedAt: "2026-04-23T09:00:00.000Z",
      voidBusinessDate: "2026-04-23",
      voidReason: "wrong cup",
      voidLocalId: "void-server-1",
      hydratedAt: "2026-04-23T09:10:00.000Z",
    });
    expect(row.voidedAt).toBe("2026-04-23T09:00:00.000Z");
    expect(row.voidReason).toBe("wrong cup");
  });

  it("leaves an in-flight outbox row alone so the drain still owns the push", async () => {
    const repo = fixture.repos.pendingSales;
    // A `queued` outbox row already exists locally — the cashier rang it
    // moments before checking find-sale. The cross-device hydration must
    // not flip it to synced or overwrite its payload; only the void mirror
    // is allowed to advance, so the summary card reflects the server's
    // canonical void state when the kitchen device confirmed the void.
    await repo.enqueue(
      makeSale({
        localSaleId: "018f9c1a-4b2e-7c00-b000-000000abc123",
        clerkId: "counter-clerk",
      }),
    );
    const row = await repo.upsertSyncedFromRemote({
      serverSaleId: "server-sale-keep",
      serverSaleName: "SALE-9999",
      localSaleId: "018f9c1a-4b2e-7c00-b000-000000abc123",
      outletId: "outlet-a",
      clerkId: "kitchen-clerk", // server's clerk; must NOT overwrite the local one
      businessDate: "2026-04-23",
      createdAt: "2026-04-23T08:00:00.000Z",
      subtotalIdr: toRupiah(10_000),
      discountIdr: toRupiah(0),
      totalIdr: toRupiah(10_000),
      items: [],
      tenders: [],
      voidedAt: "2026-04-23T09:00:00.000Z",
      voidBusinessDate: "2026-04-23",
      voidReason: "kitchen mistake",
      voidLocalId: "void-server-1",
      hydratedAt: "2026-04-23T09:10:00.000Z",
    });
    expect(row.status).toBe("queued"); // drain still owns it
    expect(row.clerkId).toBe("counter-clerk"); // local payload untouched
    expect(row.voidedAt).toBe("2026-04-23T09:00:00.000Z"); // mirror advanced
  });
});
