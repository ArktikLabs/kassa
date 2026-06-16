import { expect, test, type Page } from "@playwright/test";
import { seedEnrolledDevice as seedEnrolledDeviceShared } from "./helpers/seed.js";

/*
 * KASA-366 — park / hold cart, reload, resume.
 *
 * Three assertions in one happy-path spec, mirroring the acceptance
 * criteria on the issue:
 *
 *   1. Park three carts with distinct labels → the parked tray shows
 *      three rows and the active cart resets to empty after each park.
 *   2. Reload the PWA → the three parked rows survive (Dexie-backed).
 *   3. Resume the second parked cart → the cart panel rehydrates with
 *      the parked lines and the tray drops to two rows.
 */

const OUTLET_ID = "22222222-2222-7222-8222-222222222222";
const ITEM_ID = "44444444-4444-7444-8444-444444444444";
const UOM_ID = "55555555-5555-7555-8555-555555555555";

async function seedEnrolledDevice(page: Page): Promise<void> {
  await seedEnrolledDeviceShared(page, {
    outletId: OUTLET_ID,
    itemId: ITEM_ID,
    uomId: UOM_ID,
    priceIdr: 18_000,
    itemName: "Kopi Susu",
  });
}

async function addItemAndPark(page: Page, label: string): Promise<void> {
  await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
  // KASA-347 — `page.goto("/cart")` is a full document load and resets the
  // zustand cart store, so `cart-lines` would never render. Drive the same
  // route swap through the bottom-nav TanStack `<Link>` to keep the active
  // cart alive across navigations.
  await page.getByRole("link", { name: "Keranjang", exact: true }).click();
  await expect(page.getByTestId("cart-lines")).toBeVisible();
  await page.getByTestId("cart-park-cta").click();
  const sheet = page.getByTestId("park-cart-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("park-cart-label-input").fill(label);
  await sheet.getByTestId("park-cart-confirm").click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("cart-empty")).toBeVisible();
  await page.getByRole("link", { name: "Katalog", exact: true }).click();
}

test("park 3 carts → reload → resume the second", async ({ page }) => {
  await seedEnrolledDevice(page);

  // 1. Park three carts with distinct labels.
  await addItemAndPark(page, "Meja 1");
  await addItemAndPark(page, "Meja 2");
  await addItemAndPark(page, "Meja 3");

  await page.getByRole("link", { name: "Keranjang", exact: true }).click();
  const trayCta = page.getByTestId("cart-parked-tray-cta");
  await expect(trayCta).toBeVisible();
  await expect(trayCta).toContainText("3");
  // Active cart is empty after each park.
  await expect(page.getByTestId("cart-empty")).toBeVisible();

  // 2. Reload — Dexie keeps the rows.
  await page.reload();
  await expect(page.getByTestId("cart-parked-tray-cta")).toContainText("3");

  // Open the tray; assert all three rows present.
  await page.getByTestId("cart-parked-tray-cta").click();
  const tray = page.getByTestId("parked-tray-sheet");
  await expect(tray).toBeVisible();
  await expect(tray.getByTestId("parked-tray-row")).toHaveCount(3);

  // 3. Resume "Meja 2".
  await tray
    .getByTestId("parked-tray-row")
    .filter({ hasText: "Meja 2" })
    .getByTestId("parked-tray-row-resume")
    .click();

  await expect(tray).toBeHidden();
  await expect(page.getByTestId("cart-lines")).toBeVisible();
  // Tray drops to two rows.
  const trayCtaAfter = page.getByTestId("cart-parked-tray-cta");
  await expect(trayCtaAfter).toContainText("2");
});
