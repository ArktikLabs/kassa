import { expect, test, type Page } from "@playwright/test";
import { seedEnrolledDevice as seedEnrolledDeviceShared } from "./helpers/seed.js";

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
  await seedEnrolledDeviceShared(page, {
    outletId: OUTLET_ID,
    itemId: ITEM_ID,
    uomId: UOM_ID,
  });
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

    // KASA-252 — WhatsApp share button. Pre-confirm, it renders as a
    // disabled <button> with the "waiting for sync" hint visible.
    const share = page.getByTestId("receipt-share-whatsapp");
    await expect(share).toBeVisible();
    await expect(share).toBeDisabled();
    await expect(page.getByTestId("receipt-share-whatsapp-pending")).toBeVisible();

    // Promote the pending sale to a confirmed (server-id present) sale
    // by writing serverSaleName directly to Dexie — the smoke config has
    // no API harness, so faking the post-sync state is the cheapest way
    // to exercise the enabled <a> path and the wa.me href assertion.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const all = await new Promise<{ localSaleId: string; serverSaleName: string | null }[]>(
          (resolve, reject) => {
            const tx = db.transaction("pending_sales", "readonly");
            const req = tx.objectStore("pending_sales").getAll();
            req.onsuccess = () =>
              resolve(
                req.result as { localSaleId: string; serverSaleName: string | null }[],
              );
            req.onerror = () => reject(req.error);
          },
        );
        for (const row of all) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("pending_sales", "readwrite");
            tx.objectStore("pending_sales").put({
              ...(row as unknown as Record<string, unknown>),
              serverSaleName: "S-FAKE-0001",
              status: "synced",
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

    // The live query re-renders the screen; the same testid now resolves
    // to an <a target="_blank" href="https://wa.me/?text=…">. Assert the
    // outlet name and rupiah total round-trip through decodeURIComponent.
    await expect
      .poll(
        async () =>
          share.evaluate((el) => (el.tagName === "A" ? el.getAttribute("href") : null)),
        { timeout: 5_000 },
      )
      .toMatch(/^https:\/\/wa\.me\/\?text=/);
    await expect(share).toHaveAttribute("target", "_blank");
    const href = await share.getAttribute("href");
    if (!href) throw new Error("share button missing href once confirmed");
    const body = decodeURIComponent(href.replace("https://wa.me/?text=", ""));
    expect(body).toContain("Warung Maju");
    expect(body).toMatch(/Rp\s?25\.000/);
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
