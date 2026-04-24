import { expect, test, type Page } from "@playwright/test";

/*
 * KASA-61 acceptance tests for the cash tender flow.
 *
 * Every test seeds the Dexie `kassa-pos` store directly via raw IndexedDB so
 * we do not need an API stub: the clerk is pre-enrolled, one item exists in
 * the catalog with a known stock level. After seeding we reload so the app
 * boots with the hydrated state.
 */

const OUTLET_ID = "22222222-2222-7222-8222-222222222222";
const ITEM_ID = "44444444-4444-7444-8444-444444444444";
const UOM_ID = "55555555-5555-7555-8555-555555555555";

async function seedEnrolledDevice(page: Page): Promise<void> {
  await page.goto("/enrol");
  // Wait for SW + Dexie's initial open to complete — the enrol heading only
  // renders after `hydrateEnrolment()` has settled.
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg && reg.active);
  });
  await page.getByRole("heading", { name: /Enrol perangkat/ }).waitFor();
  await page.evaluate(
    async ({ outletId, itemId, uomId }) => {
      async function openDb(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open("kassa-pos", 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
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
        code: "KP-001",
        name: "Kopi Susu",
        priceIdr: 25_000,
        uomId,
        bomId: null,
        isStockTracked: true,
        isActive: true,
        updatedAt: "2026-04-23T00:00:00.000Z",
      });
      await put(db, "stock_snapshot", {
        key: `${outletId}::${itemId}`,
        outletId,
        itemId,
        onHand: 10,
        updatedAt: "2026-04-23T00:00:00.000Z",
      });
      db.close();
    },
    { outletId: OUTLET_ID, itemId: ITEM_ID, uomId: UOM_ID },
  );
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: /Katalog/ })).toBeVisible();
  await expect(page.getByTestId(`catalog-tile-${ITEM_ID}`)).toBeVisible();
}

async function addItemAndOpenTender(page: Page): Promise<void> {
  await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
  await page.getByRole("link", { name: /Tunai/ }).click();
  await expect(page.getByTestId("tender-cash")).toBeVisible();
}

test.describe("KASA-61 cash tender flow", () => {
  test("happy path online: Pas chip, Selesai, receipt renders", async ({ page }) => {
    await seedEnrolledDevice(page);
    await addItemAndOpenTender(page);
    await page.getByTestId("chip-tender.cash.chip.pas").click();
    await expect(page.getByTestId("tender-change")).toHaveText(/0/);
    await page.getByTestId("tender-submit").click();
    await expect(page.getByTestId("receipt-preview")).toBeVisible();
    await expect(page.getByTestId("receipt-print")).toBeVisible();
  });

  test("happy path offline: sale persists locally when network is down", async ({
    page,
    context,
  }) => {
    await seedEnrolledDevice(page);
    await addItemAndOpenTender(page);
    await context.setOffline(true);
    await page.getByTestId("chip-tender.cash.chip.100k").click();
    await expect(page.getByTestId("tender-change")).toHaveText(/75\.000/);
    await page.getByTestId("tender-submit").click();
    await expect(page.getByTestId("receipt-preview")).toBeVisible();
    await expect(page.locator('[data-state="offline"]')).toBeVisible();
  });

  test("oversized tender shows correct change due", async ({ page }) => {
    await seedEnrolledDevice(page);
    await addItemAndOpenTender(page);
    await page.getByTestId("chip-tender.cash.chip.200k").click();
    await expect(page.getByTestId("tender-total")).toContainText("25.000");
    await expect(page.getByTestId("tender-change")).toContainText("175.000");
    await expect(page.getByTestId("tender-submit")).toBeEnabled();
  });

  test("cart-empty guard: Selesai disabled and warning visible", async ({ page }) => {
    await seedEnrolledDevice(page);
    await page.goto("/tender/cash");
    await expect(page.getByTestId("tender-cash")).toBeVisible();
    await expect(page.getByTestId("tender-cart-empty")).toBeVisible();
    await expect(page.getByTestId("tender-submit")).toBeDisabled();
  });
});
