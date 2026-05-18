import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HARNESS_BASE_URL } from "./harness/void-fixtures.js";

/*
 * KASA-241 (child of KASA-236) — E2E coverage for the POS void flow.
 *
 * Four scenarios:
 *   1. Happy path online — enrol, open shift, ring Rp 50,000 cash sale,
 *      void via UI with seeded manager PIN. Assert:
 *        - POST /v1/sales/:id/void returns 201 + sale stamped voidedAt.
 *        - Drawer expected cash drops by Rp 50,000 (EOD close breakdown).
 *        - Stock ledger has balancing `sale_void` rows summing per component
 *          to +qty of the original sale's BOM-explosion.
 *        - Receipt view shows the PEMBATALAN banner.
 *   2. Idempotent replay — repost the void with the same `localVoidId` twice;
 *      the second returns 200 with empty ledger and the same `voidedAt`.
 *   3. Cashier rejection — submit a void with a non-manager `managerStaffId`;
 *      assert 403 + the "Membutuhkan PIN manajer" toast.
 *   4. Offline-buffered void — go offline, void via UI, come back online;
 *      assert the outbox drains and the sale ends up voided server-side.
 *
 * Harness: `apps/pos/e2e/harness/void-server.ts` wires the manager-PIN +
 * open-shift gates that the KASA-68 harness deliberately keeps off. A fresh
 * enrolment code per `POST /__test__/seed` lets each test enrol its own
 * browser context — keeps the suite serial-but-isolated.
 */

interface Seed {
  code: string;
  outletId: string;
  merchantId: string;
  itemId: string;
  componentItemId: string;
  managerStaffId: string;
  cashierStaffId: string;
  managerPin: string;
}

interface DeviceCreds {
  apiKey: string;
  apiSecret: string;
  deviceId: string;
  outletId: string;
}

interface SaleSummary {
  localSaleId: string;
  serverSaleId: string;
  totalIdr: number;
  businessDate: string;
}

interface ServerLedgerEntry {
  id: string;
  itemId: string;
  delta: number;
  reason: string;
  refType: string | null;
  refId: string | null;
}

interface ServerSale {
  saleId: string;
  localSaleId: string;
  outletId: string;
  totalIdr: number;
  businessDate: string;
  voidedAt: string | null;
  voidBusinessDate: string | null;
  tenders: { method: string; amountIdr: number }[];
  items: { itemId: string; quantity: number }[];
}

const SALE_PRICE_IDR = 50_000;
const COMPONENT_DEDUCT_QTY = 15; // 1× BOM-parent → 15g of component (see harness BOM seed).

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.describe.configure({ mode: "serial" });

test.describe("KASA-241 void flow", () => {
  test("happy path online: void via UI, server records 201 + balanced ledger", async ({
    browser,
    request,
  }) => {
    test.setTimeout(2 * 60_000);
    const seed = await freshSeed(request);
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const creds = await enrolDevice(page, seed);
      await openShiftViaUi(page);
      const sale = await ringUpCashSale(page);
      expect(sale.localSaleId, "localSaleId is uuidV7-shaped").toMatch(UUID_V7_REGEX);
      expect(sale.serverSaleId, "sale must be synced before void is allowed").not.toBe("");
      expect(sale.totalIdr).toBe(SALE_PRICE_IDR);

      // Drive the void via the receipt CTA → manager-PIN form → submit.
      await page
        .locator('a[href="/catalog"]')
        .first()
        .click()
        .catch(() => {});
      await page.goto(`/receipt/${sale.localSaleId}`);
      await page.getByTestId("receipt-void-cta").click();
      await page.getByTestId("sale-void-form").waitFor();
      await page.getByTestId("sale-void-manager-staff-id").fill(seed.managerStaffId);
      await page.getByTestId("sale-void-manager-pin").fill(seed.managerPin);
      await page.getByTestId("sale-void-submit").click();

      // Submitting routes back to /receipt/$id on success; the PEMBATALAN
      // banner renders against the optimistic voidedAt before the API
      // round-trip lands.
      await page.waitForURL(/\/receipt\//, { timeout: 15_000 });
      await expect(page.getByTestId("receipt-pembatalan-banner")).toBeVisible({
        timeout: 10_000,
      });

      // pending_voids row drained to `synced` after the online call.
      await waitForVoidsDrained(page);

      // Server-side assertions.
      const serverSale = await getServerSale(request, creds, sale.serverSaleId);
      expect(serverSale.voidedAt, "server stamped voidedAt").not.toBeNull();
      expect(serverSale.voidBusinessDate, "voidBusinessDate set").not.toBeNull();

      // Stock ledger: the original sale's BOM explosion wrote
      // `delta=-COMPONENT_DEDUCT_QTY` on the component item with
      // reason="sale". The void must write a balancing +qty row with
      // reason="sale_void". Net per component should be zero.
      const ledger = await listLedger(request, creds, seed.outletId);
      const componentLedger = ledger.filter((r) => r.itemId === seed.componentItemId);
      const saleRows = componentLedger.filter(
        (r) => r.reason === "sale" && r.refId === sale.serverSaleId,
      );
      const voidRows = componentLedger.filter(
        (r) => r.reason === "sale_void" && r.refId === sale.serverSaleId,
      );
      const saleDelta = sumDelta(saleRows);
      const voidDelta = sumDelta(voidRows);
      expect(saleDelta, "BOM explosion deducted component on sale").toBe(-COMPONENT_DEDUCT_QTY);
      expect(voidDelta, "void wrote a balancing +qty ledger row").toBe(COMPONENT_DEDUCT_QTY);
      expect(saleDelta + voidDelta, "net ledger delta on void is zero").toBe(0);

      // EOD close at this outlet on the sale's businessDate. With the
      // void in place, expectedCashIdr should be zero — the only cash
      // sale was the one we just cancelled.
      const eod = await closeEod(request, creds, seed.outletId, sale.businessDate, [
        sale.localSaleId,
      ]);
      expect(eod.expectedCashIdr, "drawer expected-cash drops back to zero after void").toBe(0);
      expect(eod.varianceIdr).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test("idempotent replay: same localVoidId twice → 201 then 200, empty ledger second time", async ({
    browser,
    request,
  }) => {
    test.setTimeout(2 * 60_000);
    const seed = await freshSeed(request);
    const ctx = await browser.newContext();
    let creds: DeviceCreds;
    let sale: SaleSummary;
    try {
      const page = await ctx.newPage();
      creds = await enrolDevice(page, seed);
      await openShiftViaUi(page);
      sale = await ringUpCashSale(page);
    } finally {
      await ctx.close();
    }

    const localVoidId = newUuidV7();
    const voidedAt = new Date().toISOString();

    const first = await request.post(`${HARNESS_BASE_URL}/v1/sales/${sale.serverSaleId}/void`, {
      headers: deviceHeaders(creds),
      data: {
        localVoidId,
        managerStaffId: seed.managerStaffId,
        managerPin: seed.managerPin,
        voidedAt,
        voidBusinessDate: sale.businessDate,
        reason: "qa-suite",
      },
    });
    expect(first.status(), "first void creates new row").toBe(201);
    const firstBody = (await first.json()) as {
      ledger: ServerLedgerEntry[];
      voidedAt: string;
      localVoidId: string;
    };
    expect(firstBody.localVoidId).toBe(localVoidId);
    expect(firstBody.ledger.length, "first void writes balancing ledger rows").toBeGreaterThan(0);
    const stampedAt = firstBody.voidedAt;

    const second = await request.post(`${HARNESS_BASE_URL}/v1/sales/${sale.serverSaleId}/void`, {
      headers: deviceHeaders(creds),
      data: {
        localVoidId,
        managerStaffId: seed.managerStaffId,
        managerPin: seed.managerPin,
        voidedAt: new Date(Date.now() + 60_000).toISOString(),
        voidBusinessDate: sale.businessDate,
        reason: "qa-suite",
      },
    });
    expect(second.status(), "replay returns 200, not 201").toBe(200);
    const secondBody = (await second.json()) as {
      ledger: ServerLedgerEntry[];
      voidedAt: string;
    };
    expect(secondBody.ledger, "replay writes no ledger rows").toEqual([]);
    expect(secondBody.voidedAt, "voidedAt is the originally stamped time").toBe(stampedAt);
  });

  test("cashier rejection: non-manager staffId → 403 with manager-pin-required toast", async ({
    browser,
    request,
  }) => {
    test.setTimeout(2 * 60_000);
    const seed = await freshSeed(request);
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const creds = await enrolDevice(page, seed);
      await openShiftViaUi(page);
      const sale = await ringUpCashSale(page);

      // Direct API call with cashier id — the SaleVoidScreen also surfaces
      // the same toast, but the route-level 403 is the contract we want to
      // pin here. The UI path is exercised in the happy-path test above.
      const resp = await request.post(`${HARNESS_BASE_URL}/v1/sales/${sale.serverSaleId}/void`, {
        headers: deviceHeaders(creds),
        data: {
          localVoidId: newUuidV7(),
          managerStaffId: seed.cashierStaffId,
          managerPin: seed.managerPin,
          voidedAt: new Date().toISOString(),
          voidBusinessDate: sale.businessDate,
          reason: "qa-suite",
        },
      });
      expect(resp.status(), "cashier role is rejected").toBe(403);
      const body = (await resp.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("void_requires_manager");

      // Sanity-check the UI surfaces the corresponding toast. We re-use
      // the same cashier id via the form so the planVoidFollowUp branch
      // for manager_pin_required is exercised end-to-end.
      await page.goto(`/receipt/${sale.localSaleId}`);
      await page.getByTestId("receipt-void-cta").click();
      await page.getByTestId("sale-void-manager-staff-id").fill(seed.cashierStaffId);
      await page.getByTestId("sale-void-manager-pin").fill(seed.managerPin);
      await page.getByTestId("sale-void-submit").click();
      // Toast i18n is "Membutuhkan PIN manajer" under id-ID. The toast
      // surface has no testid; match by visible role+text.
      await expect(page.getByText(/Membutuhkan PIN manajer/)).toBeVisible({ timeout: 10_000 });
      // Stays on the void form; the inline error mirrors the toast.
      await expect(page.getByTestId("sale-void-error")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("offline-buffered void: queued offline, drains on reconnect, server ends voided", async ({
    browser,
    request,
  }) => {
    test.setTimeout(2 * 60_000);
    const seed = await freshSeed(request);
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const creds = await enrolDevice(page, seed);
      await openShiftViaUi(page);
      const sale = await ringUpCashSale(page);

      // Drop the network and drive the void via UI. The optimistic
      // PEMBATALAN banner should render against the local row even though
      // the POST never lands.
      await ctx.setOffline(true);
      await page.goto(`/receipt/${sale.localSaleId}`);
      await page.getByTestId("receipt-void-cta").click();
      await page.getByTestId("sale-void-manager-staff-id").fill(seed.managerStaffId);
      await page.getByTestId("sale-void-manager-pin").fill(seed.managerPin);
      await page.getByTestId("sale-void-submit").click();
      // Routes back to /receipt with the "queued" toast.
      await page.waitForURL(/\/receipt\//, { timeout: 15_000 });
      await expect(page.getByTestId("receipt-pembatalan-banner")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(/Pembatalan akan diproses saat online/)).toBeVisible({
        timeout: 10_000,
      });

      // While offline the row stays queued.
      const queuedSnapshot = await readPendingVoids(page);
      expect(
        queuedSnapshot.length,
        "pending_voids has at least one row while offline",
      ).toBeGreaterThan(0);
      expect(
        queuedSnapshot.every((r) => r.status !== "synced"),
        "no row is synced before reconnect",
      ).toBeTruthy();

      // Reconnect, trigger push, and wait for drain.
      await ctx.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await waitForVoidsDrained(page);

      // Server-side: the sale ends up voided.
      const serverSale = await getServerSale(request, creds, sale.serverSaleId);
      expect(serverSale.voidedAt, "void drained server-side after reconnect").not.toBeNull();
    } finally {
      await ctx.close();
    }
  });
});

// ---------- helpers ----------

async function freshSeed(request: APIRequestContext): Promise<Seed> {
  const resp = await request.post(`${HARNESS_BASE_URL}/__test__/seed`);
  expect(resp.ok(), "harness seed endpoint must be reachable").toBeTruthy();
  return (await resp.json()) as Seed;
}

async function enrolDevice(page: Page, seed: Seed): Promise<DeviceCreds> {
  await page.goto("/enrol");
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return Boolean(reg?.active);
    },
    null,
    { timeout: 30_000 },
  );
  // Locale-agnostic selectors (CI may run en-US or id-ID).
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
  await page.locator("#enrol-code").fill(seed.code);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(catalog|shift\/open)$/, { timeout: 30_000 });
  // SyncProvider re-mount after the secret is durable — mirrors KASA-68
  // helper to avoid the cold-mount race where catalog pull never fires.
  await page.reload();

  const secret = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("kassa-pos");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("device_secret", "readonly");
    const req = tx.objectStore("device_secret").get("singleton");
    const value = await new Promise<unknown>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value as DeviceCreds;
  });
  return secret;
}

async function openShiftViaUi(page: Page): Promise<void> {
  await page.getByTestId("shift-open-screen").waitFor({ timeout: 30_000 });
  await page.getByTestId("shift-open-submit").click();
  await page.waitForURL(/\/catalog$/, { timeout: 30_000 });
  // Wait for the catalog tile so we know the catalog pull completed.
  await page.waitForFunction(
    async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("items", "readonly");
      const req = tx.objectStore("items").count();
      const count = await new Promise<number>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as number);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return count > 0;
    },
    null,
    { timeout: 30_000 },
  );
  // Wait for the OPEN shift to round-trip to the server. The void route
  // calls `findOpenShiftForOutlet` server-side; if our shift hasn't pushed
  // yet, the gate 422s with `void_outside_open_shift`.
  await waitForShiftSynced(page);
}

async function ringUpCashSale(page: Page): Promise<SaleSummary> {
  // SPA-navigate. `nav a[href="/catalog"]` matches the bottom-nav anchor.
  await page.locator('nav a[href="/catalog"]').first().click();
  // First (and only) catalog tile.
  await page.locator('[data-testid^="catalog-tile-"]').first().click();
  await page.locator('a[href="/tender/cash"]').click();
  await page.getByTestId("chip-tender.cash.chip.pas").click();
  await page.getByTestId("tender-submit").click();
  await expect(page.getByTestId("receipt-preview")).toBeVisible({ timeout: 15_000 });

  // Wait for the sale to be `synced` and to have a serverSaleId — the
  // void path 422s on `void.error.unsynced` otherwise.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const row = await readLastPendingSale(page);
    if (row && row.status === "synced" && row.serverSaleId) {
      return {
        localSaleId: row.localSaleId,
        serverSaleId: row.serverSaleId,
        totalIdr: row.totalIdr,
        businessDate: row.businessDate,
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("ringUpCashSale: sale did not sync within 30s");
}

interface PendingSaleSnapshot {
  localSaleId: string;
  totalIdr: number;
  businessDate: string;
  status: string;
  serverSaleId: string | null;
  createdAt: string;
}

async function readLastPendingSale(page: Page): Promise<PendingSaleSnapshot | null> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("kassa-pos");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction("pending_sales", "readonly");
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const req = tx.objectStore("pending_sales").getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
      if (rows.length === 0) return null;
      rows.sort((a, b) => {
        const ax = (a as { createdAt: string }).createdAt;
        const bx = (b as { createdAt: string }).createdAt;
        return ax < bx ? -1 : ax > bx ? 1 : 0;
      });
      return rows[rows.length - 1] as PendingSaleSnapshot;
    } finally {
      db.close();
    }
  });
}

async function readPendingVoids(page: Page): Promise<{ localVoidId: string; status: string }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("kassa-pos");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction("pending_voids", "readonly");
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const req = tx.objectStore("pending_voids").getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
      return rows as { localVoidId: string; status: string }[];
    } finally {
      db.close();
    }
  });
}

async function waitForVoidsDrained(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await readPendingVoids(page);
    if (rows.length > 0 && rows.every((r) => r.status === "synced")) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  const snapshot = await readPendingVoids(page);
  throw new Error(`waitForVoidsDrained timed out — last snapshot: ${JSON.stringify(snapshot)}`);
}

async function waitForShiftSynced(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const row = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = db.transaction("shift_state", "readonly");
        const req = tx.objectStore("shift_state").get("singleton");
        const result = await new Promise<unknown>((resolve, reject) => {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return result as { serverShiftId: string | null } | null;
      } finally {
        db.close();
      }
    });
    if (row?.serverShiftId) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("waitForShiftSynced timed out — open-shift event never reached the server");
}

async function getServerSale(
  request: APIRequestContext,
  creds: DeviceCreds,
  saleId: string,
): Promise<ServerSale> {
  const resp = await request.get(`${HARNESS_BASE_URL}/v1/sales/${saleId}`, {
    headers: deviceHeaders(creds),
  });
  expect(resp.ok(), `GET /v1/sales/${saleId} returned ${resp.status()}`).toBeTruthy();
  return (await resp.json()) as ServerSale;
}

async function listLedger(
  request: APIRequestContext,
  creds: DeviceCreds,
  outletId: string,
): Promise<ServerLedgerEntry[]> {
  const url = new URL(`${HARNESS_BASE_URL}/v1/stock/ledger`);
  url.searchParams.set("outletId", outletId);
  url.searchParams.set("limit", "500");
  const resp = await request.get(url.toString(), { headers: deviceHeaders(creds) });
  expect(resp.ok(), `GET /v1/stock/ledger returned ${resp.status()}`).toBeTruthy();
  const body = (await resp.json()) as { records: ServerLedgerEntry[] };
  return body.records;
}

async function closeEod(
  request: APIRequestContext,
  creds: DeviceCreds,
  outletId: string,
  businessDate: string,
  clientSaleIds: string[],
): Promise<{ expectedCashIdr: number; varianceIdr: number }> {
  const resp = await request.post(`${HARNESS_BASE_URL}/v1/eod/close`, {
    headers: { ...deviceHeaders(creds), "content-type": "application/json" },
    data: {
      outletId,
      businessDate,
      countedCashIdr: 0,
      varianceReason: null,
      clientSaleIds,
    },
  });
  expect(
    resp.ok(),
    `POST /v1/eod/close returned ${resp.status()}: ${await resp.text()}`,
  ).toBeTruthy();
  return (await resp.json()) as { expectedCashIdr: number; varianceIdr: number };
}

function deviceHeaders(creds: DeviceCreds): Record<string, string> {
  return {
    "x-kassa-api-key": creds.apiKey,
    "x-kassa-api-secret": creds.apiSecret,
    accept: "application/json",
  };
}

function sumDelta(rows: { delta: number }[]): number {
  return rows.reduce((acc, r) => acc + r.delta, 0);
}

function newUuidV7(): string {
  const ms = Date.now();
  const hex = ms.toString(16).padStart(12, "0");
  const rand = Math.random().toString(16).slice(2, 14).padEnd(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 12)}${"0".repeat(6)}`;
}
