import { expect, test, type Page } from "@playwright/test";
import { seedEnrolledDevice as seedEnrolledDeviceShared } from "./helpers/seed.js";

/*
 * KASA-309 — PDF receipt fallback for iPadOS and unsupported ESC/POS
 * printers. The Bluetooth print path stays unchanged on Android Chrome;
 * the new contract is:
 *
 *   1. With `navigator.bluetooth` defined (the default Chromium build),
 *      the cashier sees the existing `Cetak` button as the primary
 *      action and the new `Unduh PDF` button as a secondary affordance.
 *   2. With Bluetooth stubbed to `undefined` (iPadOS Safari, or any
 *      browser that simply does not expose Web Bluetooth), PDF becomes
 *      the primary action and the Bluetooth printer button is absent.
 *   3. Reprint and void flows offer the same PDF fallback.
 *
 * The download itself is asserted via Playwright's `page.waitForEvent('download')`
 * — when our `usePdfReceipt()` hook triggers an anchor click on a Blob
 * URL with a `download="kassa-..."` attribute, Chromium emits a download
 * event whose suggestedFilename matches our naming convention.
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

async function stubBluetoothUnavailable(page: Page): Promise<void> {
  // Wipe `navigator.bluetooth` before any module evaluates so the
  // `isWebBluetoothSupported()` check returns `false` on the very first
  // render. `addInitScript` runs in every frame ahead of bundle init.
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "bluetooth", {
        get() {
          return undefined;
        },
        configurable: true,
      });
    } catch {
      // Some Chromium builds leave `bluetooth` as a non-configurable
      // accessor — falling back to deleting via Reflect keeps the
      // override best-effort across releases.
      Reflect.deleteProperty(navigator, "bluetooth");
    }
  });
}

async function completeSaleAndOpenReceipt(page: Page): Promise<void> {
  await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
  await page.getByRole("link", { name: /Tunai/ }).click();
  await page.getByTestId("chip-tender.cash.chip.pas").click();
  await page.getByTestId("tender-submit").click();
  await expect(page.getByTestId("receipt-preview")).toBeVisible({ timeout: 15_000 });
}

test.describe("KASA-309 PDF receipt fallback", () => {
  test("Bluetooth available → printer primary, PDF secondary", async ({ page }) => {
    // Inject a `navigator.bluetooth` shim ahead of seed so the truthy
    // check in `isWebBluetoothSupported()` returns true. We never
    // actually click the printer here — the shim only needs to be
    // present, not functional.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "bluetooth", {
        get() {
          return {
            requestDevice() {
              return Promise.reject(new Error("stub"));
            },
          };
        },
        configurable: true,
      });
    });
    await seedEnrolledDevice(page);
    await completeSaleAndOpenReceipt(page);

    const printer = page.getByTestId("receipt-print");
    const pdf = page.getByTestId("receipt-pdf");
    await expect(printer).toBeVisible();
    await expect(pdf).toBeVisible();
    await expect(pdf).toHaveAttribute("data-variant", "secondary");
  });

  test("Bluetooth unavailable → PDF primary, no printer button", async ({ page }) => {
    await stubBluetoothUnavailable(page);
    await seedEnrolledDevice(page);
    await completeSaleAndOpenReceipt(page);

    const pdf = page.getByTestId("receipt-pdf");
    await expect(pdf).toBeVisible();
    await expect(pdf).toHaveAttribute("data-variant", "primary");
    // Bluetooth-print button must NOT render when Web Bluetooth is
    // absent — the cashier should not be able to click an action that
    // will always fail on this device.
    await expect(page.getByTestId("receipt-print")).toHaveCount(0);

    // Wire up the download capture before clicking — Playwright loses
    // events that fire before `waitForEvent` arms.
    const downloadPromise = page.waitForEvent("download");
    await pdf.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^kassa-${OUTLET_ID.slice(0, 8)}-.+\\.pdf$`),
    );
    await expect(page.getByTestId("receipt-pdf-status")).toBeVisible();
  });

  test("Voided sale on Bluetooth-unavailable browser keeps PDF fallback", async ({ page }) => {
    await stubBluetoothUnavailable(page);
    await seedEnrolledDevice(page);
    await completeSaleAndOpenReceipt(page);

    // Flip the locally-stored sale to voided so the receipt screen
    // renders the PEMBATALAN banner without exercising the full void
    // flow (which requires a server-side serverSaleId). The PDF button
    // must still surface as the primary action.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const tx = db.transaction("pending_sales", "readonly");
          const req = tx.objectStore("pending_sales").getAll();
          req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>);
          req.onerror = () => reject(req.error);
        });
        for (const row of rows) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("pending_sales", "readwrite");
            tx.objectStore("pending_sales").put({
              ...row,
              voidedAt: "2026-04-23T08:35:00.000Z",
              voidBusinessDate: "2026-04-23",
              voidReason: "Test void",
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
        }
      } finally {
        db.close();
      }
    });
    await page.reload();

    await expect(page.getByTestId("receipt-pembatalan-banner")).toBeVisible();
    const pdf = page.getByTestId("receipt-pdf");
    await expect(pdf).toBeVisible();
    await expect(pdf).toHaveAttribute("data-variant", "primary");
  });
});
