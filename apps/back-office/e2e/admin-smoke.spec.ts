import { expect, test, type Route } from "@playwright/test";

/*
 * Laptop-viewport smoke: sign in with the seeded owner credential,
 * land on the Dashboard surface (KASA-237 default landing), then walk
 * across to Outlets / Catalog and create an item. Covers KASA-67 +
 * KASA-237 golden paths.
 *
 * Run with `pnpm --filter @kassa/back-office e2e` — the Playwright
 * config spins up a preview server on :4174 via `pnpm build && pnpm preview`,
 * baking `VITE_API_BASE_URL=http://localhost:4174` so the login client
 * issues a relative `/v1/auth/session/login` POST that the route handler
 * below intercepts.
 */

test("owner signs in, sees the dashboard, and creates a catalog item", async ({ page }) => {
  // KASA-182: the login form now POSTs to the API. The smoke suite has no
  // backing service, so stub the staff-session endpoint with a valid response
  // shape (mirrors `sessionLoginResponse` in `@kassa/schemas/auth`).
  await page.route("**/v1/auth/session/login", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "set-cookie": "kassa_session=stub; Path=/; HttpOnly" },
      body: JSON.stringify({
        email: "siti@warungpusat.id",
        displayName: "Siti Rahayu",
        role: "owner",
        merchantId: "01928a47-0000-7000-8000-000000000001",
        issuedAt: "2026-04-23T00:00:00.000+07:00",
      }),
    });
  });

  await page.goto("/login");

  await page.getByLabel("Email").fill("siti@warungpusat.id");
  await page.getByLabel("Kata sandi").fill("welcome-to-kassa");
  await page.getByRole("button", { name: "Masuk" }).click();

  // KASA-237 — owner / manager land on /admin/dashboard after login. Either
  // the heading is visible (preview API responds) or the inline error
  // surfaces (preview API not configured) — both prove the route mounted.
  await expect(page.getByRole("heading", { name: "Dasbor harian", level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "Katalog", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Katalog", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Tambah produk" }).click();
  await page.getByLabel("SKU").fill("KOP-001");
  await page.getByLabel("Nama produk").fill("Kopi Susu");
  await page.getByLabel("Harga (IDR)").fill("18000");
  await page.getByRole("button", { name: "Simpan produk" }).click();

  await expect(page.getByText("Kopi Susu")).toBeVisible();
});
