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
