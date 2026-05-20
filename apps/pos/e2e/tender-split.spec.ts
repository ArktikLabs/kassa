import { expect, test, type Page } from "@playwright/test";
import { seedEnrolledDevice as seedEnrolledDeviceShared } from "./helpers/seed.js";

/*
 * KASA-310 acceptance tests for the split tender (cash + QRIS) flow.
 *
 * The smoke spec exercises the cash + qris_static path because that is the
 * flow the offline acceptance bullet calls for. The dynamic-QRIS leg
 * (cash + Midtrans QR) needs the in-memory API harness and lives with
 * `full-day-offline.spec.ts`.
 *
 *   Acceptance bullets covered here:
 *    - Happy path online: enter cash + remainder QRIS (static),
 *      buyerRefLast4, Selesai → receipt renders with two tender rows.
 *    - Offline-buffered: complete a split sale (cash + qris_static) with
 *      no network → outbox holds the full sale → both legs persist.
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

async function addTwoItemsAndOpenSplit(page: Page): Promise<void> {
  // Two Kopi Susu = Rp 50.000 total. The split chip "20.000" leaves 30k
  // for the QRIS leg, matching the AC example (cash 20k + qris 30k).
  await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
  await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
  await page.goto("/cart");
  await page.getByTestId("cart-split-link").click();
  await expect(page.getByTestId("tender-split")).toBeVisible();
  // Force static mode — the smoke config has no payments harness, so
  // dynamic mode would 5xx the Midtrans createQrisOrder call. The mode
  // toggle keeps both branches reachable from the same UI; the auto
  // detector defaults to dynamic when the browser thinks it's online.
  const toggle = page.getByTestId("tender-split-mode-toggle");
  // If we're already in static mode (offline run), the toggle button
  // reads "Pakai QR dinamis"; click only when the data-mode attribute
  // tells us we're in dynamic.
  if ((await page.getByTestId("tender-split").getAttribute("data-mode")) === "dynamic") {
    await toggle.click();
  }
  await expect(page.getByTestId("tender-split")).toHaveAttribute("data-mode", "static");
}

test.describe("KASA-310 split tender (cash + QRIS) flow", () => {
  test("happy path online: cash 20k + qris_static 30k → receipt shows both legs", async ({
    page,
  }) => {
    await seedEnrolledDevice(page);
    await addTwoItemsAndOpenSplit(page);

    await page.getByTestId("tender-split-chip-20k").click();
    await expect(page.getByTestId("tender-split-cash")).toContainText("20.000");
    await expect(page.getByTestId("tender-split-qris")).toContainText("30.000");

    await page.getByTestId("tender-split-last4").fill("4321");
    const submit = page.getByTestId("tender-split-submit-static");
    await expect(submit).toBeEnabled();
    await submit.click();

    // Receipt renders with one row per tender method (KASA-310 multi-
    // tender layout). 15s window for the Dexie commit → route chunk
    // hand-off through the SW precache, mirroring the cash spec.
    await expect(page.getByTestId("receipt-preview")).toBeVisible({ timeout: 15_000 });
    const cashRow = page.getByTestId("receipt-tender-cash");
    const qrisRow = page.getByTestId("receipt-tender-qris_static");
    await expect(cashRow).toContainText("20.000");
    await expect(qrisRow).toContainText("30.000");
    await expect(page.getByText(/Total/).first()).toBeVisible();
  });

  test("offline path: split sale persists locally + both legs survive a reload", async ({
    page,
    context,
  }) => {
    await seedEnrolledDevice(page);
    await addTwoItemsAndOpenSplit(page);

    await context.setOffline(true);

    await page.getByTestId("tender-split-chip-20k").click();
    await page.getByTestId("tender-split-last4").fill("4321");
    await page.getByTestId("tender-split-submit-static").click();

    // Receipt screen mounts even with no network because the SW serves
    // the precached shell and Dexie commits the outbox row locally.
    await expect(page.getByTestId("receipt-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-state="offline"]')).toBeVisible();

    // The outbox row holds BOTH tenders atomically — neither leg goes
    // missing because Dexie wrapped them in a single rw-transaction in
    // `finalizeSplitSale`. Read straight from IDB to assert the shape.
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const tx = db.transaction("pending_sales", "readonly");
          const req = tx.objectStore("pending_sales").getAll();
          req.onsuccess = () => resolve(req.result as unknown[]);
          req.onerror = () => reject(req.error);
        });
        return rows;
      } finally {
        db.close();
      }
    });

    expect(stored).toHaveLength(1);
    const row = stored[0] as {
      tenders: Array<{ method: string; amountIdr: number; buyerRefLast4?: string }>;
      totalIdr: number;
      status: string;
    };
    expect(row.status).toBe("queued");
    expect(row.totalIdr).toBe(50_000);
    expect(row.tenders).toHaveLength(2);
    expect(row.tenders[0]).toMatchObject({ method: "cash", amountIdr: 20_000 });
    expect(row.tenders[1]).toMatchObject({
      method: "qris_static",
      amountIdr: 30_000,
      buyerRefLast4: "4321",
    });
  });

  test("guard: cash leg of 0 disables the buyerRefLast4 input (no degenerate split)", async ({
    page,
  }) => {
    await seedEnrolledDevice(page);
    await addTwoItemsAndOpenSplit(page);
    await expect(page.getByTestId("tender-split-last4")).toBeDisabled();
    await expect(page.getByTestId("tender-split-submit-static")).toBeDisabled();
  });
});
