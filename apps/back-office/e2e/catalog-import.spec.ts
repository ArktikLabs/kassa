import { expect, test } from "@playwright/test";

/*
 * KASA-311 — back-office /admin/catalog/import golden path.
 *
 * Three behaviours pinned down by the AC:
 *   1. owner uploads a small CSV and sees the diff (new + existing-by-sku),
 *   2. confirming the import lands the rows on /catalog,
 *   3. re-importing the same CSV is a no-op (unchanged count goes up,
 *      no duplicate items).
 *
 * Run with `pnpm --filter @kassa/back-office e2e`. The Playwright config
 * spins up `pnpm preview` on :4174 so this is a real browser walk against
 * the production build.
 */

const TEMPLATE = [
  "sku,name,price_idr,uom,is_stock_tracked,is_active",
  "IMP-001,Es Jeruk,8000,pcs,false,true",
  "NSI-001,Nasi Ayam,25000,porsi,false,true",
].join("\n");

test("owner imports a catalog CSV end-to-end", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("siti@warungpusat.id");
  await page.getByLabel("Kata sandi").fill("welcome-to-kassa");
  await page.getByRole("button", { name: "Masuk" }).click();
  // KASA-406 — KASA-368 changed the post-login landing from "Outlet" to
  // "Dasbor harian" (per-cashier daily report). Cashier-day spec already
  // asserts the new heading; this one drifted.
  await expect(page.getByRole("heading", { name: "Dasbor harian", level: 1 })).toBeVisible();

  await page.goto("/admin/catalog/import");
  await expect(page.getByRole("heading", { name: "Impor katalog (CSV)" })).toBeVisible();

  // Round 1 — fresh upload. IMP-001 is new; NSI-001 matches the seeded row
  // by SKU but with a different name/price so it lands in the update bucket.
  await page.getByLabel("Pilih file CSV").setInputFiles({
    name: "menu.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(TEMPLATE, "utf8"),
  });

  await expect(page.getByTestId("summary-create")).toContainText("1");
  await expect(page.getByTestId("summary-update")).toContainText("1");
  await expect(page.getByTestId("summary-skip")).toContainText("0");

  await page.getByRole("button", { name: "Konfirmasi impor" }).click();
  await expect(page.getByTestId("import-result")).toBeVisible();

  // Round 2 — same file. Both rows should now match exactly so they
  // collapse into the unchanged bucket.
  await page.getByRole("button", { name: "Batal" }).click();
  await page.getByLabel("Pilih file CSV").setInputFiles({
    name: "menu.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(TEMPLATE, "utf8"),
  });
  await expect(page.getByTestId("summary-create")).toContainText("0");
  await expect(page.getByTestId("summary-update")).toContainText("0");
  await expect(page.getByTestId("summary-unchanged")).toContainText("2");

  // Round 3 — bad row keeps the confirm button disabled.
  await page.getByLabel("Pilih file CSV").setInputFiles({
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "sku,name,price_idr,uom,is_stock_tracked,is_active",
        ",Missing sku,5000,pcs,false,true",
      ].join("\n"),
      "utf8",
    ),
  });
  await expect(page.getByRole("button", { name: "Konfirmasi impor" })).toBeDisabled();
  await expect(page.getByTestId("summary-skip")).toContainText("1");
});
