import { expect, test } from "@playwright/test";

/*
 * Laptop-viewport smoke: sign in with the seeded owner credential,
 * land on the Outlets surface, and create a catalog item. Golden-path
 * coverage per KASA-67 acceptance criteria.
 *
 * Run with `pnpm --filter @kassa/back-office e2e` — the Playwright
 * config spins up a preview server on :4174 via `pnpm preview`.
 */

test("owner signs in and creates a catalog item", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill("siti@warungpusat.id");
  await page.getByLabel("Kata sandi").fill("welcome-to-kassa");
  await page.getByRole("button", { name: "Masuk" }).click();

  await expect(page.getByRole("heading", { name: "Outlet", level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "Katalog", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Katalog", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Tambah produk" }).click();
  await page.getByLabel("SKU").fill("KOP-001");
  await page.getByLabel("Nama produk").fill("Kopi Susu");
  await page.getByLabel("Harga (IDR)").fill("18000");
  await page.getByRole("button", { name: "Simpan produk" }).click();

  await expect(page.getByText("Kopi Susu")).toBeVisible();
});
