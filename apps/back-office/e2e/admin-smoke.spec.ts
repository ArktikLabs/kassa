import { expect, test } from "@playwright/test";

/*
 * Laptop-viewport smoke: sign in with the seeded owner credential,
 * land on the Outlets surface, and create a catalog item. Golden-path
 * coverage per KASA-67 acceptance criteria.
 *
 * Run with `pnpm --filter @kassa/back-office e2e` — the Playwright
 * config builds the SPA with a stub `VITE_API_BASE_URL` and serves it
 * via `pnpm preview` on :4174. The login round-trip is mocked here
 * with `page.route()` so the lane stays hermetic and does not depend
 * on a live API (KASA-193).
 */

const SEEDED_OWNER = {
  email: "siti@warungpusat.id",
  password: "welcome-to-kassa",
};

// Shape comes from `@kassa/schemas/auth.sessionLoginResponse`. The session
// itself is held server-side in an HTTP-only cookie (ARCHITECTURE §4.1);
// the back-office only persists the body fields to localStorage, so the
// mock does not need a Set-Cookie header for the spec to pass.
const SESSION_LOGIN_RESPONSE = {
  email: SEEDED_OWNER.email,
  displayName: "Siti Rahayu",
  role: "owner" as const,
  merchantId: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-05-08T00:00:00+07:00",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/auth/session/login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SESSION_LOGIN_RESPONSE),
    });
  });
});

test("owner signs in and creates a catalog item", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill(SEEDED_OWNER.email);
  await page.getByLabel("Kata sandi").fill(SEEDED_OWNER.password);
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
