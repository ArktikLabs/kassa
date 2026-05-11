import { expect, test, type Page, type Route } from "@playwright/test";
import { seedEnrolledDevice as seedEnrolledDeviceShared } from "./helpers/seed.js";

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
  await seedEnrolledDeviceShared(page, {
    outletId: OUTLET_ID,
    itemId: ITEM_ID,
    uomId: UOM_ID,
  });
}

async function addItemAndOpenQris(page: Page): Promise<void> {
  // Cart state lives in zustand (in-memory), so a hard `page.goto`
  // resets it and the QRIS submit button stays disabled with
  // "Keranjang kosong". Reach the QRIS route through the SPA — bottom
  // nav → "Tunai" → in-page "Bayar QRIS" switcher — so the cart line
  // survives the route transitions.
  await page.getByTestId(`catalog-tile-${ITEM_ID}`).click();
  await page.getByRole("link", { name: /Tunai/ }).click();
  await page.getByTestId("tender-cash-switch-qris").click();
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
    // "creating…" loading state and detaches once we move to "waiting", so a
    // rapid second click should be a no-op. The synchronous `creatingRef`
    // guard inside `handleCreate` is what actually prevents a second POST —
    // this test asserts that semantic regardless of where the second click
    // lands relative to React committing the next step.
    const button = page.getByTestId("tender-qris-create");
    await button.click();
    // Bound the second click: the button may already be detached by now, and
    // an unbounded force-click would burn the entire test budget waiting for
    // it to reappear, leaving zero time for the visibility assertion below.
    await button.click({ force: true, timeout: 1_000 }).catch(() => {
      /* button already detached after step transitioned to "waiting" */
    });
    // Guard semantic: only one POST regardless of how the second click landed.
    await expect.poll(() => state.createCalls, { timeout: 5_000 }).toBe(1);
    await expect(page.getByTestId("tender-qris-qr")).toBeVisible();
  });
});
