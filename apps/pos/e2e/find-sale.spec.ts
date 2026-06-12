import { expect, test, type Page } from "@playwright/test";
import { seedEnrolledDevice } from "./helpers/seed.js";

/*
 * KASA-369 — Playwright smoke for the counter-side find-sale lookup.
 *
 * Mirrors the tender-cash spec's IDB-seeding approach: pre-enroll the
 * device, drop a synced sale into `pending_sales` directly, then
 * navigate to `/find-sale` and exercise the lookup-by-receipt-code
 * happy path plus the outside-shift dead-end. We do not run a real
 * void here — the smoke config has no API harness, and the eligibility
 * gate (which is what KASA-369 owns) lives entirely client-side.
 */

const OUTLET_ID = "22222222-2222-7222-8222-222222222222";
const ITEM_ID = "44444444-4444-7444-8444-444444444444";
const UOM_ID = "55555555-5555-7555-8555-555555555555";

const SALE_LOCAL_ID = "018f9c1a-4b2e-7c00-b000-000000abc123";
const RECEIPT_CODE = "ABC123";

interface SeedSaleOptions {
  businessDate?: string;
  voidedAt?: string | null;
}

async function seedSyncedSale(page: Page, opts: SeedSaleOptions = {}): Promise<void> {
  const businessDate = opts.businessDate ?? "2026-04-23";
  const voidedAt = opts.voidedAt ?? null;
  await page.evaluate(
    async ({
      saleLocalId,
      outletId,
      itemId,
      uomId,
      businessDate: bd,
      voidedAt: voidStamp,
    }: {
      saleLocalId: string;
      outletId: string;
      itemId: string;
      uomId: string;
      businessDate: string;
      voidedAt: string | null;
    }) => {
      async function openDb(): Promise<IDBDatabase> {
        let version: number | undefined;
        try {
          const dbs = await indexedDB.databases();
          version = dbs.find((d) => d.name === "kassa-pos")?.version;
        } catch {
          version = undefined;
        }
        return new Promise((resolve, reject) => {
          const req =
            version != null ? indexedDB.open("kassa-pos", version) : indexedDB.open("kassa-pos");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error("kassa-pos open blocked by another connection"));
        });
      }
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("pending_sales", "readwrite");
          tx.objectStore("pending_sales").put({
            localSaleId: saleLocalId,
            outletId,
            clerkId: "cashier-1",
            businessDate: bd,
            createdAt: `${bd}T08:00:00.000Z`,
            subtotalIdr: 25_000,
            discountIdr: 0,
            totalIdr: 25_000,
            items: [
              {
                itemId,
                bomId: null,
                quantity: 1,
                uomId,
                unitPriceIdr: 25_000,
                lineTotalIdr: 25_000,
              },
            ],
            tenders: [{ method: "cash", amountIdr: 25_000, reference: null }],
            status: "synced",
            attempts: 0,
            lastError: null,
            lastAttemptAt: `${bd}T08:00:01.000Z`,
            serverSaleName: "POS-SALE-0001",
            serverSaleId: "server-sale-1",
            voidedAt: voidStamp,
            voidBusinessDate: voidStamp ? bd : null,
            voidReason: null,
            voidLocalId: voidStamp ? "void-1" : null,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    {
      saleLocalId: SALE_LOCAL_ID,
      outletId: OUTLET_ID,
      itemId: ITEM_ID,
      uomId: UOM_ID,
      businessDate,
      voidedAt,
    },
  );
}

test.describe("KASA-369 find past sale by receipt code", () => {
  test("happy path: lookup resolves to summary card with Reprint + Void enabled", async ({
    page,
  }) => {
    await seedEnrolledDevice(page, { outletId: OUTLET_ID, itemId: ITEM_ID, uomId: UOM_ID });
    await seedSyncedSale(page, { businessDate: "2026-04-23" });

    await page.goto("/find-sale");
    await expect(page.getByTestId("find-sale-screen")).toBeVisible();

    await page.getByTestId("find-sale-input").fill(RECEIPT_CODE.toLowerCase());
    await page.getByTestId("find-sale-submit").click();

    const summary = page.getByTestId("find-sale-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute("data-local-sale-id", SALE_LOCAL_ID);
    await expect(page.getByTestId("find-sale-summary-code")).toHaveText(RECEIPT_CODE);
    await expect(page.getByTestId("find-sale-summary-confirmed")).toBeVisible();
    await expect(page.getByTestId("find-sale-reprint")).toBeEnabled();
    await expect(page.getByTestId("find-sale-void")).toBeEnabled();
  });

  test("not-found dead-end: unknown code surfaces id-ID warning panel", async ({ page }) => {
    await seedEnrolledDevice(page, { outletId: OUTLET_ID, itemId: ITEM_ID, uomId: UOM_ID });

    await page.goto("/find-sale");
    await page.getByTestId("find-sale-input").fill("999999");
    await page.getByTestId("find-sale-submit").click();
    await expect(page.getByTestId("find-sale-not-found")).toBeVisible();
    await expect(page.getByTestId("find-sale-summary")).toHaveCount(0);
  });

  test("outside-shift: Reprint stays enabled, Void disabled with a Bahasa hint", async ({
    page,
  }) => {
    await seedEnrolledDevice(page, { outletId: OUTLET_ID, itemId: ITEM_ID, uomId: UOM_ID });
    // The seeded shift_state row is dated 2026-04-23; this sale on the
    // prior day cannot be voided here (the back-office reconciliation
    // flow owns prior-shift voids per KASA-236-B).
    await seedSyncedSale(page, { businessDate: "2026-04-22" });

    await page.goto("/find-sale");
    await page.getByTestId("find-sale-input").fill(RECEIPT_CODE);
    await page.getByTestId("find-sale-submit").click();

    await expect(page.getByTestId("find-sale-summary")).toBeVisible();
    await expect(page.getByTestId("find-sale-reprint")).toBeEnabled();
    await expect(page.getByTestId("find-sale-void")).toBeDisabled();
    await expect(page.getByTestId("find-sale-void-blocked")).toBeVisible();
  });
});

/*
 * KASA-370 — cross-device server fallback. The kitchen tablet rang the
 * sale; the counter tablet has no Dexie row for the receipt code. While
 * online, `/find-sale` falls back to `GET /v1/sales?receiptCode=…`. We
 * stub the route via `page.route` so the smoke spec stays harness-free
 * (the in-memory API runs only under `playwright.full-day-offline.config.ts`).
 */
test.describe("KASA-370 cross-device find-sale fallback", () => {
  const REMOTE_SALE_LOCAL_ID = "018f9c1a-4b2e-7c00-b000-000000cafe01";
  const REMOTE_RECEIPT_CODE = "CAFE01";

  test("server lookup hydrates the summary card from the kitchen tablet's sale", async ({
    page,
  }) => {
    let calls = 0;
    let lastUrl = "";
    await page.route("**/v1/sales*", async (route) => {
      const url = new URL(route.request().url());
      // Only intercept the receiptCode variant — the existing list/get
      // routes must reach the server, even though the smoke config has
      // none (the test itself doesn't navigate to them, so a 404 is OK).
      if (!url.searchParams.has("receiptCode")) return route.fallback();
      calls += 1;
      lastUrl = url.toString();
      const body = {
        saleId: "11111111-1111-7111-8111-111111111111",
        name: "POS-SALE-X1",
        localSaleId: REMOTE_SALE_LOCAL_ID,
        outletId: OUTLET_ID,
        clerkId: "kitchen-clerk",
        // Match the seeded shift_state's businessDate so the void CTA
        // stays enabled — the eligibility gate only allows voids on the
        // current open shift's day.
        businessDate: "2026-04-23",
        subtotalIdr: 35_000,
        discountIdr: 0,
        totalIdr: 35_000,
        taxIdr: 0,
        items: [
          {
            itemId: ITEM_ID,
            bomId: null,
            quantity: 1,
            uomId: UOM_ID,
            unitPriceIdr: 35_000,
            lineTotalIdr: 35_000,
          },
        ],
        tenders: [{ method: "cash", amountIdr: 35_000, reference: null }],
        createdAt: "2026-04-23T09:05:00.000Z",
        voidedAt: null,
        voidBusinessDate: null,
        voidReason: null,
        localVoidId: null,
        refunds: [],
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await seedEnrolledDevice(page, { outletId: OUTLET_ID, itemId: ITEM_ID, uomId: UOM_ID });

    await page.goto("/find-sale");
    await expect(page.getByTestId("find-sale-screen")).toBeVisible();

    // Counter tablet has no Dexie row for the kitchen sale, so the
    // submit must fall through to the server.
    await page.getByTestId("find-sale-input").fill(REMOTE_RECEIPT_CODE);
    await page.getByTestId("find-sale-submit").click();

    const summary = page.getByTestId("find-sale-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute("data-local-sale-id", REMOTE_SALE_LOCAL_ID);
    await expect(page.getByTestId("find-sale-summary-code")).toHaveText(REMOTE_RECEIPT_CODE);
    await expect(page.getByTestId("find-sale-summary-confirmed")).toBeVisible();
    // Reprint + Void resolve through Dexie, which the fallback hydrated;
    // the downstream screens can read the sale just like a same-device hit.
    await expect(page.getByTestId("find-sale-reprint")).toBeEnabled();
    await expect(page.getByTestId("find-sale-void")).toBeEnabled();

    expect(calls).toBe(1);
    expect(lastUrl).toContain(`outletId=${OUTLET_ID}`);
    expect(lastUrl).toContain(`receiptCode=${REMOTE_RECEIPT_CODE}`);
  });

  test("server 404 surfaces the same id-ID dead-end the offline branch shows", async ({ page }) => {
    await page.route("**/v1/sales*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("receiptCode")) return route.fallback();
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "sale_not_found", message: "Struk tidak ditemukan." },
        }),
      });
    });

    await seedEnrolledDevice(page, { outletId: OUTLET_ID, itemId: ITEM_ID, uomId: UOM_ID });

    await page.goto("/find-sale");
    await page.getByTestId("find-sale-input").fill(REMOTE_RECEIPT_CODE);
    await page.getByTestId("find-sale-submit").click();
    await expect(page.getByTestId("find-sale-not-found")).toBeVisible();
    await expect(page.getByTestId("find-sale-summary")).toHaveCount(0);
  });
});
