import { expect, type Page } from "@playwright/test";

/*
 * Shared seed helper for the smoke tender specs.
 *
 * Two responsibilities the per-spec helpers were duplicating:
 *
 *  1. Wait for the SW to actually control the document, not merely
 *     activate. The tender flows depend on the offline shell being
 *     loaded from precache when the network is dropped mid-test, so we
 *     gate on `controller != null` (KASA-159 root cause B for the
 *     offline tender path).
 *
 *  2. Honour whatever IndexedDB version Dexie has already opened. The
 *     POS app boots Dexie at `DB_VERSION = 4`, which Dexie maps to
 *     underlying IDB version 40. Hard-coding `indexedDB.open(name, 1)`
 *     in the seed (or even calling without a version on a fresh
 *     Chromium) raises `VersionError: requested version (1) < existing
 *     (40)`. We query `indexedDB.databases()` for the live version and
 *     reopen at exactly that, so the seed never lies about the schema
 *     shape and survives further Dexie `version()` bumps.
 */

export interface SeedItem {
  outletId: string;
  itemId: string;
  uomId: string;
  itemCode?: string;
  itemName?: string;
  priceIdr?: number;
  onHand?: number;
}

export async function waitForControllingServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) return false;
    if (navigator.serviceWorker.controller != null) return true;
    await new Promise<void>((resolve) => {
      const onChange = () => {
        navigator.serviceWorker.removeEventListener("controllerchange", onChange);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", onChange, { once: true });
      setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", onChange);
        resolve();
      }, 200);
    });
    return navigator.serviceWorker.controller != null;
  });
}

export async function seedEnrolledDevice(page: Page, item: SeedItem): Promise<void> {
  await page.goto("/enrol");
  await waitForControllingServiceWorker(page);
  await page.getByRole("heading", { name: /Enrol perangkat/ }).waitFor();
  await page.evaluate(
    async ({
      outletId,
      itemId,
      uomId,
      itemCode,
      itemName,
      priceIdr,
      onHand,
    }: Required<SeedItem>) => {
      async function readLiveVersion(): Promise<number | undefined> {
        // `indexedDB.databases()` is unsupported in some headless
        // configurations; fall through to a version-less open if it
        // throws. The handler still has to deal with the case where
        // Chromium opens at version 1 on a never-created store.
        try {
          const dbs = await indexedDB.databases();
          return dbs.find((d) => d.name === "kassa-pos")?.version;
        } catch {
          return undefined;
        }
      }
      async function openDb(): Promise<IDBDatabase> {
        const version = await readLiveVersion();
        return new Promise((resolve, reject) => {
          const req =
            version != null ? indexedDB.open("kassa-pos", version) : indexedDB.open("kassa-pos");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error("kassa-pos open blocked by another connection"));
        });
      }
      async function put(
        db: IDBDatabase,
        store: string,
        value: Record<string, unknown>,
      ): Promise<void> {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(value);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      }
      const db = await openDb();
      try {
        await put(db, "device_secret", {
          id: "singleton",
          deviceId: "11111111-1111-7111-8111-111111111111",
          outletId,
          outletName: "Warung Maju",
          merchantId: "33333333-3333-7333-8333-333333333333",
          merchantName: "Toko Maju",
          apiKey: "pk",
          apiSecret: "sk",
          enrolledAt: "2026-04-23T00:00:00.000Z",
        });
        await put(db, "outlets", {
          id: outletId,
          code: "MAIN",
          name: "Warung Maju",
          timezone: "Asia/Jakarta",
          updatedAt: "2026-04-23T00:00:00.000Z",
        });
        await put(db, "items", {
          id: itemId,
          code: itemCode,
          name: itemName,
          priceIdr,
          uomId,
          bomId: null,
          isStockTracked: true,
          // KASA-218 made `Item.taxRate` required; the finalize path passes it
          // to `computeSaleTaxIdr`, which crashes on undefined rates because
          // `toRupiah(NaN)` throws. Mirror the production sync default so the
          // seeded item matches a real catalog row.
          taxRate: 11,
          isActive: true,
          updatedAt: "2026-04-23T00:00:00.000Z",
        });
        await put(db, "stock_snapshot", {
          key: `${outletId}::${itemId}`,
          outletId,
          itemId,
          onHand,
          updatedAt: "2026-04-23T00:00:00.000Z",
        });
        // KASA-235 added a boot guard on /catalog, /cart, /tender/* that
        // redirects to /shift/open until `shift_state` has an unclosed row.
        // Seed the singleton so the tender specs can land directly on the
        // sale flow the same way they did before the guard existed.
        await put(db, "shift_state", {
          id: "singleton",
          localShiftId: "66666666-6666-7666-8666-666666666666",
          outletId,
          cashierStaffId: "77777777-7777-7777-8777-777777777777",
          businessDate: "2026-04-23",
          openShiftId: "66666666-6666-7666-8666-666666666666",
          openedAt: "2026-04-23T00:00:00.000Z",
          openingFloatIdr: 0,
          serverShiftId: null,
          closedAt: null,
        });
      } finally {
        db.close();
      }
    },
    {
      outletId: item.outletId,
      itemId: item.itemId,
      uomId: item.uomId,
      itemCode: item.itemCode ?? "KP-001",
      itemName: item.itemName ?? "Kopi Susu",
      priceIdr: item.priceIdr ?? 25_000,
      onHand: item.onHand ?? 10,
    },
  );
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: /Katalog/ })).toBeVisible();
  await expect(page.getByTestId(`catalog-tile-${item.itemId}`)).toBeVisible();
}
