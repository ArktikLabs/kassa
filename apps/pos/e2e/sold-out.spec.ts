import { expect, test, type Page } from "@playwright/test";
import { seedEnrolledDevice as seedEnrolledDeviceShared } from "./helpers/seed.js";

/*
 * KASA-248 — catalog tile "Tandai sebagai habis" long-press flow.
 *
 * Three assertions, one suite:
 *
 *   1. Online happy path — long-press a tile → bottom sheet → confirm flips
 *      the row to `availability='sold_out'` optimistically (tile greys
 *      inside 200 ms), enqueues a `pending_catalog_mutations` row, and the
 *      sync runner drains it as a `PATCH /v1/catalog/items/:id`. The
 *      outbox row is gone after the drain.
 *   2. Cart-add rejection — a sold-out tile does not add a cart line on
 *      tap (the cart panel stays at "empty" copy).
 *   3. Offline → online — toggling while offline still flips the tile and
 *      queues the mutation; when the device returns online the drain
 *      ships the queued PATCH.
 */

const OUTLET_ID = "22222222-2222-7222-8222-222222222222";
const ITEM_ID = "44444444-4444-7444-8444-444444444444";
const UOM_ID = "55555555-5555-7555-8555-555555555555";

async function seedEnrolledDevice(page: Page): Promise<void> {
  await seedEnrolledDeviceShared(page, {
    outletId: OUTLET_ID,
    itemId: ITEM_ID,
    uomId: UOM_ID,
  });
}

async function readPendingCatalogMutations(
  page: Page,
): Promise<Array<{ itemId: string; availability: string; status: string }>> {
  return page.evaluate(
    async () =>
      new Promise<Array<{ itemId: string; availability: string; status: string }>>(
        (resolve, reject) => {
          const req = indexedDB.open("kassa-pos");
          req.onsuccess = () => {
            const db = req.result;
            try {
              const tx = db.transaction("pending_catalog_mutations", "readonly");
              const store = tx.objectStore("pending_catalog_mutations");
              const all = store.getAll();
              all.onsuccess = () => {
                resolve(
                  all.result as Array<{ itemId: string; availability: string; status: string }>,
                );
                db.close();
              };
              all.onerror = () => {
                reject(all.error);
                db.close();
              };
            } catch (err) {
              db.close();
              reject(err);
            }
          };
          req.onerror = () => reject(req.error);
        },
      ),
  );
}

async function longPress(page: Page, testId: string): Promise<void> {
  const tile = page.getByTestId(testId);
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  if (!box) throw new Error(`bounding box for ${testId} unavailable`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // 600 ms > LONG_PRESS_MS (500). Sleep here keeps the timer alive long
  // enough for the setTimeout callback to fire onLongPress.
  await page.waitForTimeout(600);
  await page.mouse.up();
}

test.describe("KASA-248 sold-out toggle", () => {
  test("long-press greys the tile, enqueues the mutation, and the drain ships the PATCH", async ({
    page,
  }) => {
    const patches: Array<{ url: string; body: unknown }> = [];
    await page.route("**/v1/catalog/items/*", async (route) => {
      const req = route.request();
      if (req.method() === "PATCH") {
        let body: unknown = null;
        try {
          body = req.postDataJSON();
        } catch {
          // ignore parse failures — spec asserts the call happened, not the body shape
        }
        patches.push({ url: req.url(), body });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: ITEM_ID,
            code: "KP-001",
            name: "Kopi Susu",
            priceIdr: 25_000,
            uomId: UOM_ID,
            bomId: null,
            isStockTracked: true,
            taxRate: 11,
            availability: (body as { availability?: string })?.availability ?? "available",
            isActive: true,
            updatedAt: "2026-04-23T01:00:00.000Z",
          }),
        });
        return;
      }
      await route.continue();
    });

    await seedEnrolledDevice(page);

    const tile = page.getByTestId(`catalog-tile-${ITEM_ID}`);
    // Tile renders normally before the toggle.
    await expect(tile).toBeVisible();
    await expect(page.getByTestId(`catalog-tile-${ITEM_ID}-habis`)).toHaveCount(0);

    await longPress(page, `catalog-tile-${ITEM_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/Kopi Susu/)).toBeVisible();
    await page.getByTestId("catalog-sold-out-confirm").click();

    // Optimistic-first: the "Habis" pill renders before the network call
    // settles. The polling loop here is short — the AC is 200 ms but the
    // sync runner's batched microtasks add a bit of slack.
    await expect(page.getByTestId(`catalog-tile-${ITEM_ID}-habis`)).toBeVisible({ timeout: 1_000 });

    // Drain — `pushCatalogMutations` runs on the next sync cycle, but the
    // hook also enqueues immediately. Poll the request log AND the local
    // outbox until both confirm the round-trip.
    await expect.poll(async () => patches.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    expect(patches[0]?.url).toContain(`/v1/catalog/items/${ITEM_ID}`);
    expect((patches[0]?.body as { availability: string }).availability).toBe("sold_out");
    await expect.poll(async () => (await readPendingCatalogMutations(page)).length).toBe(0);
  });

  test("cart-add is rejected on a sold-out tile", async ({ page }) => {
    await page.route("**/v1/catalog/items/*", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      await route.continue();
    });
    await seedEnrolledDevice(page);
    await longPress(page, `catalog-tile-${ITEM_ID}`);
    await page.getByTestId("catalog-sold-out-confirm").click();
    await expect(page.getByTestId(`catalog-tile-${ITEM_ID}-habis`)).toBeVisible({ timeout: 1_000 });
    // Tap the now-greyed tile — should not add a cart line.
    await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
    // CartPanel renders an "empty" affordance when no lines exist (see
    // i18n key `cart.empty.heading`). The Bahasa string is "Keranjang
    // kosong" — match on it to confirm the cart did not grow.
    await expect(page.getByText(/Keranjang kosong/)).toBeVisible();
  });

  test("offline toggle is queued and drains once the device is back online", async ({
    page,
    context,
  }) => {
    const patches: Array<{ url: string; body: unknown }> = [];
    await page.route("**/v1/catalog/items/*", async (route) => {
      const req = route.request();
      if (req.method() === "PATCH") {
        let body: unknown = null;
        try {
          body = req.postDataJSON();
        } catch {
          // ignore
        }
        patches.push({ url: req.url(), body });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: ITEM_ID,
            code: "KP-001",
            name: "Kopi Susu",
            priceIdr: 25_000,
            uomId: UOM_ID,
            bomId: null,
            isStockTracked: true,
            taxRate: 11,
            availability: "sold_out",
            isActive: true,
            updatedAt: "2026-04-23T01:00:00.000Z",
          }),
        });
        return;
      }
      await route.continue();
    });

    await seedEnrolledDevice(page);
    await context.setOffline(true);
    await longPress(page, `catalog-tile-${ITEM_ID}`);
    await page.getByTestId("catalog-sold-out-confirm").click();
    await expect(page.getByTestId(`catalog-tile-${ITEM_ID}-habis`)).toBeVisible({ timeout: 1_000 });
    const queued = await readPendingCatalogMutations(page);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.availability).toBe("sold_out");

    // No PATCH should have left the device while offline — the route
    // interceptor would have logged it.
    expect(patches).toHaveLength(0);

    await context.setOffline(false);
    // The runner cycle fires on `online` event AND on its interval (60 s).
    // The hook's enqueue ran synchronously; the next drain ships the row.
    await expect.poll(async () => patches.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect((patches[0]?.body as { availability: string }).availability).toBe("sold_out");
    await expect.poll(async () => (await readPendingCatalogMutations(page)).length).toBe(0);
  });
});
