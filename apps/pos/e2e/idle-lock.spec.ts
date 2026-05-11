import { expect, test, type Page } from "@playwright/test";
import { seedEnrolledDevice as seedEnrolledDeviceShared } from "./helpers/seed.js";

/*
 * KASA-251 — idle auto-lock acceptance.
 *
 * `page.clock.install` freezes time so `setTimeout(180_000)` doesn't
 * gate the test on wall-clock. Each `fastForward` ticks pending timers
 * deterministically.
 */

const OUTLET_ID = "22222222-2222-7222-8222-222222222251";
const ITEM_ID = "44444444-4444-7444-8444-444444444251";
const UOM_ID = "55555555-5555-7555-8555-555555555251";

async function seedAndOpenCatalog(page: Page): Promise<void> {
  await seedEnrolledDeviceShared(page, {
    outletId: OUTLET_ID,
    itemId: ITEM_ID,
    uomId: UOM_ID,
  });
  // The seed helper drops us on /enrol via goto. Once Dexie has the
  // device row, force a navigation to /catalog so the idle watcher
  // boots in the enrolled state.
  await page.goto("/catalog");
  await expect(page.getByTestId("idle-lock-content")).toBeVisible();
}

async function enterPin(page: Page, pin: string): Promise<void> {
  for (const d of pin.split("")) {
    await page.getByTestId(`lock-key-${d}`).click();
  }
  await page.getByTestId("lock-submit").click();
}

test.describe("KASA-251 idle auto-lock", () => {
  test("locks after 180s idle and unlocks on correct cashier PIN", async ({ page }) => {
    await page.clock.install();
    await seedAndOpenCatalog(page);

    await expect(page.getByTestId("lock-overlay")).toBeHidden();

    // 180 s default + a tick of slack.
    await page.clock.fastForward(181_000);

    await expect(page.getByTestId("lock-overlay")).toBeVisible();
    const content = page.getByTestId("idle-lock-content");
    await expect(content).toHaveAttribute("aria-disabled", "true");

    await enterPin(page, "1234");
    await expect(page.getByTestId("lock-overlay")).toBeHidden();
    await expect(content).not.toHaveAttribute("aria-disabled", /.*/);
  });

  test("three wrong PINs trigger the 30s cooldown banner", async ({ page }) => {
    await page.clock.install();
    await seedAndOpenCatalog(page);
    await page.clock.fastForward(181_000);
    await expect(page.getByTestId("lock-overlay")).toBeVisible();

    await enterPin(page, "0000");
    await enterPin(page, "0000");
    await enterPin(page, "0000");

    await expect(page.getByTestId("lock-cooldown")).toBeVisible();
    await expect(page.getByTestId("lock-submit")).toBeDisabled();
  });

  test("manager PIN also unlocks", async ({ page }) => {
    await page.clock.install();
    await seedAndOpenCatalog(page);
    await page.clock.fastForward(181_000);
    await expect(page.getByTestId("lock-overlay")).toBeVisible();

    await enterPin(page, "9999");
    await expect(page.getByTestId("lock-overlay")).toBeHidden();
  });
});
