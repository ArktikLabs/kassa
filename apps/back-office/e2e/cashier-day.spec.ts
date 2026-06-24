import { expect, test, type Route } from "@playwright/test";

/*
 * KASA-368 — back-office /reports/cashier-day report.
 *
 * The preview server has no backing API, so this spec stubs both the
 * staff-session login and the cashier-day JSON endpoint. The CSV endpoint
 * is exercised by asserting the download link's `href`; we don't trigger
 * an actual file save here because the stubbed endpoint would need to
 * return a CSV body and Playwright's download channel would then race
 * against the route fulfillment. The API-side route test
 * (`reports-cashier-day-routes.test.ts`) already pins the CSV envelope.
 */

const MERCHANT_ID = "01928a47-0000-7000-8000-000000000001";
const TODAY = "2026-05-29";
const OUTLET = "01928a47-0000-7000-8000-aa00000000a1";
const CASHIER_SITI = "01928a47-0000-7000-8000-cc00000000a1";
const CASHIER_DEWI = "01928a47-0000-7000-8000-cc00000000a2";

test("manager views per-cashier daily report and triggers CSV export", async ({ page }) => {
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
        role: "manager",
        merchantId: MERCHANT_ID,
        issuedAt: "2026-05-29T00:00:00.000+07:00",
      }),
    });
  });

  await page.route("**/v1/reports/cashier-day?**", async (route: Route) => {
    if (route.request().url().includes("export.csv")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outletId: OUTLET,
        businessDate: TODAY,
        rows: [
          {
            cashierStaffId: CASHIER_SITI,
            cashierName: "Siti Rahayu",
            saleCount: 4,
            grossIdr: 91_000,
            netIdr: 82_000,
            voidCount: 1,
            voidIdr: 9_000,
            tenderMix: [
              { method: "cash", amountIdr: 43_000, count: 2 },
              { method: "qris_dynamic", amountIdr: 36_000, count: 1 },
              { method: "qris_static", amountIdr: 12_000, count: 1 },
            ],
            drawerExpectedIdr: 143_000,
          },
          {
            cashierStaffId: CASHIER_DEWI,
            cashierName: "Dewi Lestari",
            saleCount: 5,
            grossIdr: 104_500,
            netIdr: 104_500,
            voidCount: 0,
            voidIdr: 0,
            tenderMix: [
              { method: "cash", amountIdr: 79_000, count: 3 },
              { method: "qris_dynamic", amountIdr: 14_500, count: 1 },
              { method: "qris_static", amountIdr: 11_000, count: 1 },
            ],
            drawerExpectedIdr: null,
          },
        ],
        totals: {
          saleCount: 9,
          grossIdr: 195_500,
          netIdr: 186_500,
          voidCount: 1,
          voidIdr: 9_000,
          tenderMix: [
            { method: "cash", amountIdr: 122_000, count: 5 },
            { method: "qris_dynamic", amountIdr: 50_500, count: 2 },
            { method: "qris_static", amountIdr: 23_000, count: 2 },
          ],
          drawerExpectedIdr: 143_000,
        },
      }),
    });
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("siti@warungpusat.id");
  await page.getByLabel("Kata sandi").fill("welcome-to-kassa");
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page.getByRole("heading", { name: "Dasbor harian", level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "Laporan kasir" }).click();
  await expect(
    page.getByRole("heading", { name: "Laporan harian per kasir", level: 1 }),
  ).toBeVisible();

  // KASA-406 — KASA-183 added the operator name to the global banner, so
  // "Siti Rahayu" now resolves to two elements (banner span + table cell).
  // Scope to the report-row cell so strict mode passes.
  await expect(page.getByRole("cell", { name: "Siti Rahayu" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Dewi Lestari" })).toBeVisible();

  // Totals card pins the day's roll-up.
  const totals = page.getByTestId("cashier-day-totals");
  await expect(totals).toContainText("195.500");
  await expect(totals).toContainText("186.500");

  // CSV export link goes to the server-rendered route, NOT a blob URL.
  const exportLink = page.getByTestId("cashier-day-export-csv");
  const href = await exportLink.getAttribute("href");
  expect(href).toContain("/v1/reports/cashier-day/export.csv");
  expect(href).toContain(`businessDate=${TODAY}`);
});

/**
 * KASA-385 — cross-midnight void overhang. Cashier A sells on day-(N-1),
 * is off on day-N, A's sale is voided on day-N. The day-N report shows
 * A's row with `grossIdr=0`, `voidIdr=50000`, `netIdr=-50000` and the UI
 * has to surface the row as a "defisit" (danger token + aria-label) so
 * the owner doesn't miss the deficit while skimming the table.
 */
test("renders cross-midnight void overhang as a defisit cell", async ({ page }) => {
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
        role: "manager",
        merchantId: MERCHANT_ID,
        issuedAt: "2026-05-29T00:00:00.000+07:00",
      }),
    });
  });

  await page.route("**/v1/reports/cashier-day?**", async (route: Route) => {
    if (route.request().url().includes("export.csv")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outletId: OUTLET,
        businessDate: TODAY,
        rows: [
          {
            cashierStaffId: CASHIER_SITI,
            cashierName: "Siti Rahayu",
            saleCount: 0,
            grossIdr: 0,
            netIdr: -50_000,
            voidCount: 1,
            voidIdr: 50_000,
            tenderMix: [],
            drawerExpectedIdr: null,
          },
        ],
        totals: {
          saleCount: 0,
          grossIdr: 0,
          netIdr: -50_000,
          voidCount: 1,
          voidIdr: 50_000,
          tenderMix: [],
          drawerExpectedIdr: null,
        },
      }),
    });
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("siti@warungpusat.id");
  await page.getByLabel("Kata sandi").fill("welcome-to-kassa");
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page.getByRole("heading", { name: "Dasbor harian", level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "Laporan kasir" }).click();
  await expect(
    page.getByRole("heading", { name: "Laporan harian per kasir", level: 1 }),
  ).toBeVisible();

  await expect(page.getByText("Siti Rahayu")).toBeVisible();

  // Both row + totals card carry the defisit testid with a localized aria.
  const defisit = page.getByTestId("cashier-day-net-defisit");
  await expect(defisit.first()).toHaveAttribute("aria-label", "defisit");
  await expect(defisit).toHaveCount(2);
  for (const cell of await defisit.all()) {
    await expect(cell).toHaveClass(/text-danger-fg/);
  }
});
