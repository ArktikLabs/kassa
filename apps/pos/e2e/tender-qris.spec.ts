import { expect, test, type Page, type Route } from "@playwright/test";

/*
 * KASA-63 acceptance tests for the dynamic QRIS tender flow.
 *
 * We stub `POST /v1/payments/qris` and `GET /v1/payments/qris/:orderId/status`
 * with Playwright route handlers so every test controls the Midtrans state
 * machine without hitting the sandbox. The shared seed mirrors
 * tender-cash.spec.ts: a pre-enrolled device, one item, a stock row.
 */

const OUTLET_ID = "22222222-2222-7222-8222-222222222222";
const ITEM_ID = "44444444-4444-7444-8444-444444444444";
const UOM_ID = "55555555-5555-7555-8555-555555555555";
const QR_STRING = "00020101021226680013COM.MIDTRANS0118936009140000000000QRIS-TEST";

async function seedEnrolledDevice(page: Page): Promise<void> {
  await page.goto("/enrol");
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg?.active);
  });
  await page.getByRole("heading", { name: /Enrol perangkat/ }).waitFor();
  await page.evaluate(
    async ({ outletId, itemId, uomId }) => {
      async function openDb(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open("kassa-pos", 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      async function put(
        db: IDBDatabase,
        store: string,
        value: Record<string, unknown>,
      ): Promise<void> {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(value);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      }
      const db = await openDb();
      await put(db, "device_secret", {
        id: "singleton",
        deviceId: "11111111-1111-7111-8111-111111111111",
        outletId,
        outletName: "Warung Maju",
        merchantId: "33333333-3333-7333-8333-333333333333",
        merchantName: "Toko Maju",
        apiKey: "pk",
        apiSecret: "sk",
        enrolledAt: "2026-04-23T00:00:00.000Z",
      });
      await put(db, "outlets", {
        id: outletId,
        code: "MAIN",
        name: "Warung Maju",
        timezone: "Asia/Jakarta",
        updatedAt: "2026-04-23T00:00:00.000Z",
      });
      await put(db, "items", {
        id: itemId,
        code: "KP-001",
        name: "Kopi Susu",
        priceIdr: 25_000,
        uomId,
        bomId: null,
        isStockTracked: true,
        isActive: true,
        updatedAt: "2026-04-23T00:00:00.000Z",
      });
      await put(db, "stock_snapshot", {
        key: `${outletId}::${itemId}`,
        outletId,
        itemId,
        onHand: 10,
        updatedAt: "2026-04-23T00:00:00.000Z",
      });
      db.close();
    },
    { outletId: OUTLET_ID, itemId: ITEM_ID, uomId: UOM_ID },
  );
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: /Katalog/ })).toBeVisible();
  await expect(page.getByTestId(`catalog-tile-${ITEM_ID}`)).toBeVisible();
}

async function addItemAndOpenQris(page: Page): Promise<void> {
  await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
  await page.goto("/tender/qris");
  await expect(page.getByTestId("tender-qris")).toBeVisible();
}

interface QrisRouteState {
  createCalls: number;
  statusCalls: number;
  nextStatus: "pending" | "paid" | "expired" | "cancelled" | "failed";
  orderId: string | null;
}

async function installQrisRoutes(page: Page, state: QrisRouteState): Promise<void> {
  await page.route("**/v1/payments/qris", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    state.createCalls += 1;
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      localSaleId: string;
      amount: number;
    };
    state.orderId = body.localSaleId;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        qrisOrderId: body.localSaleId,
        qrString: QR_STRING,
        expiresAt: "2026-04-24T20:15:00+07:00",
      }),
    });
  });

  await page.route("**/v1/payments/qris/*/status", async (route: Route) => {
    state.statusCalls += 1;
    const url = new URL(route.request().url());
    const orderId = url.pathname.split("/").at(-2) ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        qrisOrderId: orderId,
        status: state.nextStatus,
        grossAmount: 25_000,
        paidAt: state.nextStatus === "paid" ? "2026-04-24T20:00:05+07:00" : null,
      }),
    });
  });
}

test.describe("KASA-63 QRIS dynamic tender flow", () => {
  test("happy path: Buat QR renders QR, polls, and auto-advances to receipt on paid", async ({
    page,
  }) => {
    const state: QrisRouteState = {
      createCalls: 0,
      statusCalls: 0,
      nextStatus: "pending",
      orderId: null,
    };
    await installQrisRoutes(page, state);
    await seedEnrolledDevice(page);
    await addItemAndOpenQris(page);

    await page.getByTestId("tender-qris-create").click();
    // QR renders inline while we still say "pending".
    await expect(page.getByTestId("tender-qris-qr")).toBeVisible();
    await expect(page.getByTestId("tender-qris-status")).toHaveAttribute("data-status", "pending");
    expect(state.createCalls).toBe(1);

    // Flip Midtrans to paid; next poll finalises and routes to receipt.
    state.nextStatus = "paid";
    await expect(page.getByTestId("receipt-preview")).toBeVisible({ timeout: 10_000 });
    expect(state.statusCalls).toBeGreaterThan(0);
  });

  test("expiration: expired state offers retry + switch-to-cash", async ({ page }) => {
    const state: QrisRouteState = {
      createCalls: 0,
      statusCalls: 0,
      nextStatus: "pending",
      orderId: null,
    };
    await installQrisRoutes(page, state);
    await seedEnrolledDevice(page);
    await addItemAndOpenQris(page);

    await page.getByTestId("tender-qris-create").click();
    await expect(page.getByTestId("tender-qris-qr")).toBeVisible();

    state.nextStatus = "expired";
    await expect(page.getByTestId("tender-qris-status")).toHaveAttribute("data-status", "expired", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("tender-qris-retry")).toBeVisible();
    await expect(page.getByTestId("tender-qris-switch-cash")).toBeVisible();

    // Switch-to-cash navigates to the cash tender route.
    await page.getByTestId("tender-qris-switch-cash").click();
    await expect(page.getByTestId("tender-cash")).toBeVisible();
  });

  test("offline fallback link appears when the create-QR call fails at the network layer", async ({
    page,
  }) => {
    await page.route("**/v1/payments/qris", async (route: Route) => {
      if (route.request().method() === "POST") {
        await route.abort("internetdisconnected");
        return;
      }
      await route.fallback();
    });
    await seedEnrolledDevice(page);
    await addItemAndOpenQris(page);

    await page.getByTestId("tender-qris-create").click();
    await expect(page.getByTestId("tender-qris-create-error")).toHaveAttribute(
      "data-error-code",
      "network_error",
    );
    // "Offline — gunakan QRIS statis" link is revealed and targets the static route.
    const fallback = page.getByTestId("tender-qris-static-fallback");
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute("href", "/tender/qris/static");
  });

  test("duplicate submit guard: clicking Buat QR twice creates exactly one order", async ({
    page,
  }) => {
    const state: QrisRouteState = {
      createCalls: 0,
      statusCalls: 0,
      nextStatus: "pending",
      orderId: null,
    };
    await installQrisRoutes(page, state);
    await seedEnrolledDevice(page);
    await addItemAndOpenQris(page);

    // First click starts the create flow; the button immediately flips into the
    // "creating…" loading state so a rapid second click should be a no-op.
    const button = page.getByTestId("tender-qris-create");
    await button.click();
    await button.click({ force: true }).catch(() => {
      /* button may already be detached after state transitions to "waiting" */
    });
    await expect(page.getByTestId("tender-qris-qr")).toBeVisible();
    expect(state.createCalls).toBe(1);
  });
});
