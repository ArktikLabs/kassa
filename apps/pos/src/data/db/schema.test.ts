import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRupiah } from "../../shared/money/index.ts";
import { createRepos, type Repos } from "./index.ts";
import { DbOpenError, KassaDexie, openKassaDb } from "./schema.ts";
import type { Item } from "./types.ts";

let dbCounter = 0;
function nextDbName(): string {
  dbCounter += 1;
  return `kassa-pos-test-${dbCounter}-${Math.random().toString(36).slice(2, 10)}`;
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

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: overrides.id ?? "item-1",
    code: overrides.code ?? "SKU-001",
    name: overrides.name ?? "Kopi Susu",
    priceIdr: overrides.priceIdr ?? toRupiah(25_000),
    uomId: overrides.uomId ?? "uom-cup",
    bomId: overrides.bomId ?? null,
    isStockTracked: overrides.isStockTracked ?? true,
    isActive: overrides.isActive ?? true,
    updatedAt: overrides.updatedAt ?? "2026-04-23T00:00:00.000Z",
  };
}

describe("KassaDexie schema", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("migrates from an empty database to the current schema version", async () => {
    expect(fixture.db.verno).toBe(4);
    const tableNames = fixture.db.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual(
      [
        "boms",
        "device_meta",
        "device_secret",
        "eod_closures",
        "items",
        "outlets",
        "pending_sales",
        "printed_qris",
        "stock_snapshot",
        "sync_state",
        "uoms",
      ].sort(),
    );
    await expect(fixture.repos.items.count()).resolves.toBe(0);
  });

  it("by default, openKassaDb wraps underlying open() failures in DbOpenError", async () => {
    const name = nextDbName();
    let attempts = 0;

    await expect(
      openKassaDb(name, {
        factory: (n) => {
          attempts += 1;
          const broken = new KassaDexie(n);
          broken.open = (() =>
            Promise.reject(new Error("simulated-read-error"))) as typeof broken.open;
          return broken;
        },
      }),
    ).rejects.toBeInstanceOf(DbOpenError);
    expect(attempts).toBe(1);

    await Dexie.delete(name);
  });

  it("with rollbackOnReadError, deletes the database and retries with a fresh instance", async () => {
    const name = nextDbName();

    // Seed a legacy row so we can prove the rollback actually wiped it.
    const seed = new Dexie(name);
    seed.version(1).stores({ items: "id" });
    await seed.open();
    await seed.table("items").put({ id: "legacy-row" });
    seed.close();

    let attempts = 0;

    const recovered = await openKassaDb(name, {
      rollbackOnReadError: true,
      factory: (n) => {
        attempts += 1;
        const db = new KassaDexie(n);
        if (attempts === 1) {
          // Fail the first open — the guard should delete and retry.
          db.open = (() => Promise.reject(new Error("simulated-read-error"))) as typeof db.open;
        }
        return db;
      },
    });

    expect(attempts).toBe(2);
    expect(recovered.verno).toBe(4);
    await expect(recovered.items.count()).resolves.toBe(0);
    recovered.close();
    await Dexie.delete(name);
  });

  it("with rollbackOnReadError, surfaces DbOpenError when the retry also fails", async () => {
    const name = nextDbName();

    await expect(
      openKassaDb(name, {
        rollbackOnReadError: true,
        factory: (n) => {
          const db = new KassaDexie(n);
          db.open = (() => Promise.reject(new Error("always-broken"))) as typeof db.open;
          return db;
        },
      }),
    ).rejects.toBeInstanceOf(DbOpenError);

    await Dexie.delete(name);
  });
});

describe("Repos — upsert idempotency and query surface", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    await teardownFixture(fixture);
  });

  it("items.upsertMany replaces existing rows by primary key without duplicating", async () => {
    await fixture.repos.items.upsertMany([makeItem()]);
    await fixture.repos.items.upsertMany([
      makeItem({ name: "Kopi Susu Gula Aren", priceIdr: toRupiah(27_000) }),
    ]);
    const row = await fixture.repos.items.getById("item-1");
    expect(row?.name).toBe("Kopi Susu Gula Aren");
    expect(row?.priceIdr).toBe(27_000);
    await expect(fixture.repos.items.count()).resolves.toBe(1);
  });

  it("items.search matches by name prefix and by code prefix", async () => {
    await fixture.repos.items.upsertMany([
      makeItem({ id: "a", code: "KP-001", name: "Kopi Susu" }),
      makeItem({ id: "b", code: "KP-002", name: "Kopi Tubruk" }),
      makeItem({ id: "c", code: "TE-001", name: "Teh Tarik" }),
    ]);
    const byName = await fixture.repos.items.search("kop");
    expect(byName.map((i) => i.id).sort()).toEqual(["a", "b"]);
    const byCode = await fixture.repos.items.search("TE-");
    expect(byCode.map((i) => i.id)).toEqual(["c"]);
  });

  it("items.getByCode returns a single row lookup by code", async () => {
    await fixture.repos.items.upsertMany([
      makeItem({ id: "a", code: "KP-001" }),
      makeItem({ id: "b", code: "KP-002" }),
    ]);
    const found = await fixture.repos.items.getByCode("KP-002");
    expect(found?.id).toBe("b");
  });

  it("pending_sales.enqueue is idempotent on localSaleId", async () => {
    const base = {
      localSaleId: "sale-1",
      outletId: "outlet-1",
      clerkId: "clerk-1",
      businessDate: "2026-04-23",
      createdAt: "2026-04-23T03:00:00.000Z",
      subtotalIdr: toRupiah(50_000),
      discountIdr: toRupiah(0),
      totalIdr: toRupiah(50_000),
      items: [],
      tenders: [],
    };
    await fixture.repos.pendingSales.enqueue(base);
    await fixture.repos.pendingSales.enqueue(base);
    await expect(fixture.repos.pendingSales.count()).resolves.toBe(1);
  });

  it("pending_sales.markError increments attempts and preserves the row", async () => {
    await fixture.repos.pendingSales.enqueue({
      localSaleId: "sale-2",
      outletId: "outlet-1",
      clerkId: "clerk-1",
      businessDate: "2026-04-23",
      createdAt: "2026-04-23T03:00:00.000Z",
      subtotalIdr: toRupiah(10_000),
      discountIdr: toRupiah(0),
      totalIdr: toRupiah(10_000),
      items: [],
      tenders: [],
    });
    await fixture.repos.pendingSales.markError("sale-2", "network", "2026-04-23T03:01:00.000Z");
    await fixture.repos.pendingSales.markError("sale-2", "500", "2026-04-23T03:02:00.000Z");
    const row = await fixture.repos.pendingSales.getById("sale-2");
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe("500");
    expect(row?.status).toBe("error");
  });

  it("sync_state cursor upserts overwrite by table key", async () => {
    await fixture.repos.syncState.setPullCursor("items", "cursor-1", "2026-04-23T01:00:00.000Z");
    await fixture.repos.syncState.setPullCursor("items", "cursor-2", "2026-04-23T01:05:00.000Z");
    const row = await fixture.repos.syncState.get("items");
    expect(row?.cursor).toBe("cursor-2");
    const all = await fixture.repos.syncState.all();
    expect(all).toHaveLength(1);
  });

  it("sync_state tracks both pull and push timestamps per table", async () => {
    await fixture.repos.syncState.setPullCursor("items", "c1", "2026-04-23T01:00:00.000Z");
    await fixture.repos.syncState.setLastPushed("pending_sales", "2026-04-23T02:00:00.000Z");
    const items = await fixture.repos.syncState.get("items");
    const outbox = await fixture.repos.syncState.get("pending_sales");
    expect(items?.cursor).toBe("c1");
    expect(items?.lastPushedAt).toBeNull();
    expect(outbox?.lastPushedAt).toBe("2026-04-23T02:00:00.000Z");
  });

  it("stock_snapshot.applyOptimisticDelta decrements the on-hand value", async () => {
    await fixture.repos.stockSnapshot.upsertMany([
      {
        key: "",
        outletId: "outlet-1",
        itemId: "item-1",
        onHand: 10,
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);
    const next = await fixture.repos.stockSnapshot.applyOptimisticDelta(
      "outlet-1",
      "item-1",
      -2,
      "2026-04-23T03:00:00.000Z",
    );
    expect(next?.onHand).toBe(8);
    const fetched = await fixture.repos.stockSnapshot.forOutletItem("outlet-1", "item-1");
    expect(fetched?.onHand).toBe(8);
  });

  it("device_secret stores a single row keyed by the singleton id", async () => {
    await fixture.repos.deviceSecret.set({
      deviceId: "device-1",
      outletId: "outlet-1",
      outletName: "Warung Maju",
      merchantId: "merchant-1",
      merchantName: "Toko Maju",
      apiKey: "pk_live_1",
      apiSecret: "secret",
      enrolledAt: "2026-04-23T00:00:00.000Z",
    });
    await fixture.repos.deviceSecret.set({
      deviceId: "device-1",
      outletId: "outlet-1",
      outletName: "Warung Maju",
      merchantId: "merchant-1",
      merchantName: "Toko Maju",
      apiKey: "pk_live_2",
      apiSecret: "secret-2",
      enrolledAt: "2026-04-23T01:00:00.000Z",
    });
    const secret = await fixture.repos.deviceSecret.get();
    expect(secret?.apiSecret).toBe("secret-2");
    await expect(fixture.db.device_secret.count()).resolves.toBe(1);
  });

  it("device_meta.ensureFingerprint generates once and reuses the stored value", async () => {
    const first = await fixture.repos.deviceMeta.ensureFingerprint();
    const second = await fixture.repos.deviceMeta.ensureFingerprint();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(fixture.db.device_meta.count()).resolves.toBe(1);
  });
});
