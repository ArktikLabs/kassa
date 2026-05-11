import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import {
  BOMS,
  FIXTURE_BUSINESS_DATE,
  HARNESS_BASE_URL,
  ITEM_AIR_ID,
  ITEM_KOPI_ID,
  ITEM_TEH_ID,
  OUTLET_A_ID,
  OUTLET_B_ID,
  OUTLET_C_ID,
  UOM_PCS_ID,
} from "./harness/fixtures.js";

/*
 * KASA-68 — full-day offline acceptance suite.
 *
 * Vision-metric gate: "Merchant completes a full sales day offline without
 * data loss — 100% success rate." The suite executes the exact scenario
 * called out in ARCHITECTURE.md §5.3 against an in-memory API harness and
 * the production POS bundle. If this test goes red, the v0 release is held.
 *
 * Scenario:
 *   1. Two devices enrol against two distinct outlets (A and B). A third
 *      outlet (C) exists in the catalog but has no device — the suite later
 *      asserts it stays untouched.
 *   2. Each device pulls catalog/BOM/stock snapshot online.
 *   3. Both devices go offline.
 *   4. Fifty sales are rung up across the two devices: a mix of cash and
 *      QRIS-static tenders, including BOM-parent items so stock-ledger
 *      explosion is exercised. A handful flow through the UI for cart-tender
 *      fidelity; the rest are seeded directly into the Dexie outbox.
 *   5. Three voids and two refunds are booked. Voids/refunds are
 *      online-only in v0 (no offline op type yet — flagged on KASA-68); the
 *      suite calls the API directly for those.
 *   6. Both devices come back online; the sync runner drains the outbox.
 *   7. Server-side assertions verify all 50 sales are present, totals match,
 *      and BOM deductions appear in the stock ledger. Outlet C ledger only
 *      holds its opening-stock seed rows (no sale ledger entries from this
 *      run).
 *   8. EOD close at A then B asserts `varianceIdr === 0`.
 *
 * Auth: the harness translates POS-style `x-kassa-api-key` headers into
 * the principal shapes production routes require — see `harness/server.ts`.
 *
 * Time budget: ~3 minutes on local hardware, comfortably under the 8-minute
 * acceptance ceiling. Increase the per-test timeout via `test.setTimeout`
 * if a slow CI runner needs more headroom; do not lower the budget — flake
 * quarantine is not permitted (any flake escalates as a P0).
 */

interface IssuedCode {
  outletId: string;
  code: string;
}

interface DeviceCreds {
  apiKey: string;
  apiSecret: string;
  deviceId: string;
  outletId: string;
}

const TOTAL_SALES = 50;
const UI_SALES_PER_DEVICE = 2;
// Distribution: outlet A gets the first half, outlet B the second. Voids
// (3) and refunds (2) are booked online from the QRIS-static slice — see
// the void/refund block in the test body.
const SALES_AT_A = TOTAL_SALES / 2;

// Mirrors `uuidV7Regex` in packages/schemas/src/sync.ts. Re-declared here so
// the seeded `localSaleId` shape can be asserted at construction time —
// otherwise a regression collapses into a 4-minute drain timeout.
const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.describe.configure({ mode: "serial" });

test("KASA-68: full-day offline acceptance gate", async ({ browser, request }) => {
  test.setTimeout(8 * 60_000);

  // Step 0: read the two enrolment codes from the harness.
  const codesResp = await request.post(`${HARNESS_BASE_URL}/__test__/codes`);
  expect(codesResp.ok(), "harness must hand out enrolment codes").toBeTruthy();
  const { codes } = (await codesResp.json()) as { codes: IssuedCode[] };
  expect(codes).toHaveLength(2);
  const codeA = codes.find((c) => c.outletId === OUTLET_A_ID);
  const codeB = codes.find((c) => c.outletId === OUTLET_B_ID);
  if (!codeA || !codeB) throw new Error("missing enrolment code for outlet A or B");

  // Step 1: enrol each device in its own browser context so Dexie stores
  // are isolated per device.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const credsA = await enrolDevice(pageA, codeA.code);
    const credsB = await enrolDevice(pageB, codeB.code);
    expect(credsA.outletId).toBe(OUTLET_A_ID);
    expect(credsB.outletId).toBe(OUTLET_B_ID);

    // KASA-235 — the catalog guard redirects an enrolled device with no
    // open shift to `/shift/open`, so a real cashier (and this suite)
    // must open the day before any sale screen is reachable. Open both
    // devices' shifts here, while still online, so the open-event drains
    // before the offline cut-over. Float = 0 keeps EOD math identical to
    // the pre-KASA-235 baseline (`expectedCash = cashSales` when the
    // server-side EOD has no shift wired).
    await openShiftViaUi(pageA);
    await openShiftViaUi(pageB);

    // Step 2: confirm catalog pull populated Dexie reference tables.
    await waitForCatalogPullComplete(pageA);
    await waitForCatalogPullComplete(pageB);

    // Step 3: pin each page's clock to the fixture business date, then go
    // offline. The UI tender path computes `businessDate` from
    // `toBusinessDate(new Date(), outlet.timezone)`; without the pin it
    // resolves to the runner's wall clock (e.g. 2026-04-26) while seeded
    // sales explicitly write FIXTURE_BUSINESS_DATE (2026-04-24). The two
    // sets land server-side on different dates, so `listSalesByDate`'s
    // exact-match filter would miss the UI sales — the local outbox audit
    // can't catch the drift because the rows are still `synced`.
    await pageA.clock.install({ time: FIXTURE_BUSINESS_DATE });
    await pageB.clock.install({ time: FIXTURE_BUSINESS_DATE });
    await ctxA.setOffline(true);
    await ctxB.setOffline(true);

    // Step 4: ring up 50 sales offline — mix of UI-driven and outbox-seeded.
    const aSalesUi = await ringUpSalesViaUi(pageA, credsA, UI_SALES_PER_DEVICE, "A");
    const bSalesUi = await ringUpSalesViaUi(pageB, credsB, UI_SALES_PER_DEVICE, "B");
    const aRemaining = SALES_AT_A - UI_SALES_PER_DEVICE;
    const bRemaining = TOTAL_SALES - SALES_AT_A - UI_SALES_PER_DEVICE;
    const aSalesSeed = await seedOutbox(pageA, credsA, aRemaining, "A");
    const bSalesSeed = await seedOutbox(pageB, credsB, bRemaining, "B");
    const submittedA = [...aSalesUi, ...aSalesSeed];
    const submittedB = [...bSalesUi, ...bSalesSeed];
    expect(submittedA.length + submittedB.length).toBe(TOTAL_SALES);
    for (const s of [...submittedA, ...submittedB]) {
      expect(s.localSaleId, "seeded localSaleId must match uuidV7").toMatch(UUID_V7_REGEX);
    }

    // Step 5/6: come back online and wait for the outbox to drain.
    await ctxA.setOffline(false);
    await ctxB.setOffline(false);
    await triggerPushAndWait(pageA);
    await triggerPushAndWait(pageB);

    // Step 7 (server-side assertions, before voids/refunds so the totals
    // line up with `submitted*`).
    const serverA = await listSalesByDate(request, credsA, OUTLET_A_ID);
    const serverB = await listSalesByDate(request, credsB, OUTLET_B_ID);
    expect(serverA).toHaveLength(submittedA.length);
    expect(serverB).toHaveLength(submittedB.length);

    const sumLocalA = sum(submittedA.map((s) => s.totalIdr));
    const sumLocalB = sum(submittedB.map((s) => s.totalIdr));
    const sumServerA = sum(serverA.map((s) => s.totalIdr));
    const sumServerB = sum(serverB.map((s) => s.totalIdr));
    expect(sumServerA, "outlet A totals match local").toBe(sumLocalA);
    expect(sumServerB, "outlet B totals match local").toBe(sumLocalB);

    // Stock ledger: each BOM-parent sale produces one component-deduct row.
    // Spot-check that outlet A and B both saw deductions; outlet C did not.
    const ledgerA = await listLedger(request, credsA, OUTLET_A_ID);
    const ledgerB = await listLedger(request, credsB, OUTLET_B_ID);
    const ledgerCsale = await listLedger(request, credsA, OUTLET_C_ID);
    const ledgerSaleRowsA = ledgerA.filter((r) => r.reason === "sale");
    const ledgerSaleRowsB = ledgerB.filter((r) => r.reason === "sale");
    expect(ledgerSaleRowsA.length, "outlet A produced ledger sale rows").toBeGreaterThan(0);
    expect(ledgerSaleRowsB.length, "outlet B produced ledger sale rows").toBeGreaterThan(0);
    expect(ledgerCsale.filter((r) => r.reason === "sale")).toHaveLength(0);

    // Step 5b: voids and refunds (online, direct API). Operate on QRIS-static
    // sales so cash variance stays clean for the EOD assertion.
    const qrisSalesA = serverA.filter((s) => s.tenders.some((t) => t.method === "qris_static"));
    const qrisSalesB = serverB.filter((s) => s.tenders.some((t) => t.method === "qris_static"));
    // Outlet A consumes indices 0..3 below: 2 voids + 2 refunds.
    expect(
      qrisSalesA.length,
      "need 4+ QRIS sales at A for 2 voids + 2 refunds",
    ).toBeGreaterThanOrEqual(4);
    expect(qrisSalesB.length, "need 1+ QRIS sales at B for void").toBeGreaterThanOrEqual(1);

    // 3 voids: 2 at A, 1 at B.
    await voidSale(request, credsA, qrisSalesA[0]!.saleId);
    await voidSale(request, credsA, qrisSalesA[1]!.saleId);
    await voidSale(request, credsB, qrisSalesB[0]!.saleId);

    // 2 refunds, both at A. Refund the FULL sale amount so the breakdown
    // does not split a partial line.
    const refundA1 = qrisSalesA[2];
    const refundA2 = qrisSalesA[3];
    expect(refundA1, "need a 3rd QRIS sale at A for refund").toBeDefined();
    expect(refundA2, "need a 4th QRIS sale at A for refund").toBeDefined();
    await refundSale(request, credsA, refundA1!);
    await refundSale(request, credsA, refundA2!);

    // Step 8: EOD close at both outlets. Cash totals exclude voided/refunded
    // QRIS sales by construction — voids/refunds were on QRIS lines only —
    // so the spec's expected cash equals the sum of cash tenders submitted.
    const expectedCashA = sumCashTenders(submittedA);
    const expectedCashB = sumCashTenders(submittedB);

    const eodA = await closeEod(request, credsA, OUTLET_A_ID, submittedA, expectedCashA);
    expect(eodA.varianceIdr, "outlet A: zero cash variance").toBe(0);
    expect(eodA.expectedCashIdr).toBe(expectedCashA);

    const eodB = await closeEod(request, credsB, OUTLET_B_ID, submittedB, expectedCashB);
    expect(eodB.varianceIdr, "outlet B: zero cash variance").toBe(0);
    expect(eodB.expectedCashIdr).toBe(expectedCashB);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

interface SubmittedSale {
  localSaleId: string;
  totalIdr: number;
  cashIdr: number;
  qrisStaticIdr: number;
}

async function enrolDevice(page: Page, code: string): Promise<DeviceCreds> {
  await page.goto("/enrol");
  // Bound every wait in this helper: locale or service-worker regressions
  // used to silently consume the entire 8-min suite ceiling instead of
  // failing fast at the offending step (KASA-68 review feedback).
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return Boolean(reg?.active);
    },
    null,
    { timeout: 30_000 },
  );
  // Match the heading by role + level rather than localized text — CI runs
  // with `en-US` locale (renders "Enrol device") while developer machines
  // typically render the Indonesian copy ("Enrol perangkat").
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
  // Type the 8-char code, then click the submit CTA. Pressing Enter on the
  // input races React's re-render: Chromium refuses to submit a form when
  // the only submit button is still `disabled`, so the keystroke fires
  // before `canSubmit` flips and the form silently no-ops. `click()`
  // auto-waits for actionable state, sidestepping the race. The selector
  // stays locale-immune because the scan/retry buttons are `type="button"`,
  // making `button[type="submit"]` unique on `/enrol`.
  await page.locator("#enrol-code").fill(code);
  await page.locator('button[type="submit"]').click();
  // Successful enrolment navigates to /catalog; the catalog guard
  // (KASA-235) immediately redirects to /shift/open when no local shift
  // exists, so accept either landing here — TanStack Router may collapse
  // the intermediate transition and never commit /catalog to history.
  await page.waitForURL(/\/(catalog|shift\/open)$/, { timeout: 30_000 });
  // SyncProvider's mount effect only calls `runner.start()` if the device
  // secret was persisted by the time it reads `deviceSecret.get()`. On the
  // first session that wrote the secret, that read races the enrolment
  // POST and only sometimes wins — meaning the catalog pull may never
  // fire. A reload re-mounts SyncProvider with the secret already in
  // Dexie, making `runner.start()` deterministic. (App-side fix tracked
  // separately; the harness pins the test to the boot path a real
  // merchant would hit on the next launch after enrolment.)
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
    return value as { apiKey: string; apiSecret: string; deviceId: string; outletId: string };
  });
  return secret;
}

async function openShiftViaUi(page: Page): Promise<void> {
  // After enrolment + reload, the catalog guard (router.tsx::guardOpenShift)
  // redirects to `/shift/open` because no local shift exists yet. Wait for
  // the screen to mount, submit with the default zero opening float, then
  // wait for the post-submit navigation back to `/catalog`. Float = 0 is
  // accepted by the screen (`ShiftOpenScreen` does not gate on a non-zero
  // amount) and keeps this suite's EOD math unchanged.
  await page.getByTestId("shift-open-screen").waitFor({ timeout: 30_000 });
  await page.getByTestId("shift-open-submit").click();
  await page.waitForURL(/\/catalog$/, { timeout: 30_000 });
}

async function waitForCatalogPullComplete(page: Page): Promise<void> {
  // The pull-runner writes one row per reference table into `sync_state`;
  // wait until items, boms, uoms, outlets, stock_snapshot are all present.
  await page.waitForFunction(
    async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("sync_state", "readonly");
      const store = tx.objectStore("sync_state");
      const required = ["items", "boms", "uoms", "outlets", "stock_snapshot"];
      const got = await Promise.all(
        required.map(
          (table) =>
            new Promise<unknown>((resolve, reject) => {
              const req = store.get(table);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            }),
        ),
      );
      db.close();
      return got.every((row) => row !== undefined && row !== null);
    },
    null,
    { timeout: 30_000 },
  );
  // Spot-check a catalog tile renders so we know the items table is hot.
  await expect(page.getByTestId(`catalog-tile-${ITEM_KOPI_ID}`)).toBeVisible({ timeout: 10_000 });
}

async function ringUpSalesViaUi(
  page: Page,
  creds: DeviceCreds,
  count: number,
  label: "A" | "B",
): Promise<SubmittedSale[]> {
  const out: SubmittedSale[] = [];
  // UI-driven sales drive the cart→tender→receipt path for cart-tender
  // fidelity; the remaining 90% of the workload is seeded directly into the
  // Dexie outbox to keep the suite under the 8-min ceiling. QRIS-static UI
  // is exercised in `tender-qris.spec.ts`; we keep the UI portion of this
  // suite to cash so the spec remains insulated from QRIS-screen churn.
  for (let i = 0; i < count; i += 1) {
    // SPA-navigate via the bottom-nav `<Link to="/catalog">` rather than
    // `page.goto("/catalog")`. Playwright's `setOffline(true)` blocks the
    // raw HTML request a hard navigation issues even when the service
    // worker has the bundle cached, so a `goto` after going offline fails
    // with `ERR_INTERNET_DISCONNECTED`. The TanStack Router link handles
    // navigation client-side and reads from Dexie, which is exactly what
    // we want to exercise. Two `<a href="/catalog">` exist on the page
    // (header brand + bottom nav); scope to the bottom nav.
    await page.locator('nav a[href="/catalog"]').click();
    await page.getByTestId(`catalog-tile-${ITEM_KOPI_ID}`).click();
    // Match by href, not localized link text ("Tunai" / "Cash"). The
    // route is the contract; the label rotates per active locale.
    await page.locator('a[href="/tender/cash"]').click();
    await page.getByTestId("chip-tender.cash.chip.pas").click();
    await page.getByTestId("tender-submit").click();
    await expect(page.getByTestId("receipt-preview")).toBeVisible({ timeout: 5_000 });
    // The just-submitted sale's localSaleId lives in pending_sales as the
    // last-created row; reading it back gives us totals to assert against.
    const justSubmitted = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("pending_sales", "readonly");
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const req = tx.objectStore("pending_sales").getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return rows.sort((a, b) => {
        const ax = (a as { createdAt: string }).createdAt;
        const bx = (b as { createdAt: string }).createdAt;
        return ax < bx ? -1 : ax > bx ? 1 : 0;
      });
    });
    const last = justSubmitted[justSubmitted.length - 1] as {
      localSaleId: string;
      totalIdr: number;
      tenders: { method: string; amountIdr: number }[];
    };
    out.push({
      localSaleId: last.localSaleId,
      totalIdr: last.totalIdr,
      cashIdr: last.tenders
        .filter((t) => t.method === "cash")
        .reduce((acc, t) => acc + t.amountIdr, 0),
      qrisStaticIdr: last.tenders
        .filter((t) => t.method === "qris_static")
        .reduce((acc, t) => acc + t.amountIdr, 0),
    });
  }
  void label;
  return out;
}

async function seedOutbox(
  page: Page,
  creds: DeviceCreds,
  count: number,
  label: "A" | "B",
): Promise<SubmittedSale[]> {
  // Build a deterministic mix: 70% cash, 30% qris-static. Half target the
  // BOM-parent kopi item (so the ledger sees BOM explosions); the rest
  // alternate teh and air to spread the workload.
  const sales = Array.from({ length: count }, (_, i) => {
    const isCash = i % 10 < 7; // 7/10 cash
    const itemRotation = i % 3;
    const itemId =
      itemRotation === 0 ? ITEM_KOPI_ID : itemRotation === 1 ? ITEM_TEH_ID : ITEM_AIR_ID;
    const bomId =
      itemId === ITEM_KOPI_ID
        ? BOMS.find((b) => b.itemId === ITEM_KOPI_ID)!.id
        : itemId === ITEM_TEH_ID
          ? BOMS.find((b) => b.itemId === ITEM_TEH_ID)!.id
          : null;
    const unitPriceIdr = itemId === ITEM_KOPI_ID ? 25_000 : itemId === ITEM_TEH_ID ? 18_000 : 8_000;
    const totalIdr = unitPriceIdr;
    return { isCash, itemId, bomId, unitPriceIdr, totalIdr };
  });

  const submitted = await page.evaluate(
    async ({ sales: payload, outletId, label: dev, uomPcsId, businessDate }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const out: {
        localSaleId: string;
        totalIdr: number;
        cashIdr: number;
        qrisStaticIdr: number;
      }[] = [];
      for (let i = 0; i < payload.length; i += 1) {
        const s = payload[i]!;
        // Synthesize a UUIDv7-shaped local id deterministic to (label, i).
        // idHex must be 32 chars so the 8-4-4-4-12 slices below all land —
        // anything shorter silently produces a malformed id that fails the
        // server-side uuidV7Regex on submit (KASA-68 review feedback).
        const idHex = `0190${dev === "A" ? "a" : "b"}000${i.toString(16).padStart(24, "0")}`;
        const localSaleId = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-7${idHex.slice(13, 16)}-8${idHex.slice(17, 20)}-${idHex.slice(20, 32)}`;
        // Date.UTC keeps the synthesized createdAt anchored to FIXTURE_BUSINESS_DATE
        // regardless of the runner's local timezone.
        const createdAt = new Date(Date.UTC(2026, 3, 24, 8, 0, i)).toISOString();
        const tender = s.isCash
          ? { method: "cash", amountIdr: s.totalIdr, reference: null }
          : {
              method: "qris_static",
              amountIdr: s.totalIdr,
              reference: null,
              verified: false,
              buyerRefLast4: "1234",
            };
        const row = {
          localSaleId,
          outletId,
          clerkId: `clerk-${dev}`,
          businessDate,
          createdAt,
          subtotalIdr: s.totalIdr,
          discountIdr: 0,
          totalIdr: s.totalIdr,
          items: [
            {
              itemId: s.itemId,
              bomId: s.bomId,
              quantity: 1,
              uomId: uomPcsId,
              unitPriceIdr: s.unitPriceIdr,
              lineTotalIdr: s.totalIdr,
            },
          ],
          tenders: [tender],
          status: "queued",
          attempts: 0,
          lastError: null,
          lastAttemptAt: null,
          serverSaleName: null,
        };
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("pending_sales", "readwrite");
          tx.objectStore("pending_sales").put(row);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        out.push({
          localSaleId,
          totalIdr: s.totalIdr,
          cashIdr: s.isCash ? s.totalIdr : 0,
          qrisStaticIdr: s.isCash ? 0 : s.totalIdr,
        });
      }
      db.close();
      return out;
    },
    {
      sales,
      outletId: creds.outletId,
      label,
      uomPcsId: UOM_PCS_ID,
      businessDate: FIXTURE_BUSINESS_DATE,
    },
  );
  return submitted;
}

async function triggerPushAndWait(page: Page): Promise<void> {
  // The sync runner re-arms automatically on the `online` window event when
  // the context flips back online; redundantly dispatch one to cover the
  // (rare) case where Playwright's setOffline(false) raced the runner's
  // listener registration.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
  // Phase 1: wait for every retriable / in-flight row to settle. `synced`
  // and `needs_attention` are terminal; the runner moves rows out of
  // `queued`/`sending`/`error` into one of those, so this condition holds
  // the moment classification finishes — even if every row was 4xx-rejected.
  //
  // We poll explicitly on the test side instead of `page.waitForFunction`.
  // Two prior attempts inside `waitForFunction` fast-passed for distinct
  // reasons:
  //  - First, the predicate used three sequential `idx.count(only(...))`
  //    reads inside one readonly tx; IDB auto-commits between awaits when
  //    no pending requests are queued, so the second/third counts landed
  //    on an inactive transaction and silently returned zero.
  //  - Then, with a single `getAll()` predicate, the trace showed the
  //    function ran exactly once before the wait returned (single console
  //    event for 25 queued rows) — an `every() === false` result that
  //    should have re-polled was instead treated as "satisfied", and the
  //    audit ran ~7ms later before the runner had drained anything.
  // Test-side polling sidesteps both modes: each iteration is its own
  // `page.evaluate` (single-shot tx, no auto-commit window), and the loop
  // only exits when the count check actually holds.
  const deadline = Date.now() + 120_000;
  let lastSnapshot = "";
  let snap: { total: number; counts: Record<string, number> } = { total: 0, counts: {} };
  while (Date.now() < deadline) {
    snap = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("kassa-pos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = db.transaction("pending_sales", "readonly");
        const rows = await new Promise<{ status: string }[]>((resolve, reject) => {
          const req = tx.objectStore("pending_sales").getAll();
          req.onsuccess = () => resolve(req.result as { status: string }[]);
          req.onerror = () => reject(req.error);
        });
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
        return { total: rows.length, counts };
      } finally {
        db.close();
      }
    });
    const snapStr = JSON.stringify(snap);
    if (snapStr !== lastSnapshot) {
      // Log only on transitions so the trace stays readable; greppable
      // as `[KASA-68 wait]` in the CI log if a future regression stalls.
      console.log(`[KASA-68 wait] ${snapStr}`);
      lastSnapshot = snapStr;
    }
    if (snap.total > 0) {
      const pending =
        (snap.counts.queued ?? 0) + (snap.counts.sending ?? 0) + (snap.counts.error ?? 0);
      if (pending === 0) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `triggerPushAndWait phase 1 timed out after 120s — last counts: ${JSON.stringify(snap)}`,
    );
  }
  // Phase 2: assert every row is `synced`. push.ts moves rows out of
  // `queued`/`sending`/`error` into either `synced` (200/201/409) or
  // `needs_attention` (terminal 4xx — push.ts:310-315), and listDrainable()
  // ignores `needs_attention` (pending-sales.ts:60-65). Without this guard,
  // a batch where every row was 4xx-rejected — or one where the runner
  // never picked up the rows at all — would satisfy phase 1 immediately
  // while producing zero server-side state. That was the misleading
  // `serverA = []` 4-second pass on PR #47.
  //
  // Surface a status histogram + sample lastError so a regression names the
  // actual failure mode (terminal 4xx vs runner-never-pushed) instead of
  // collapsing into an empty-array compare downstream.
  const audit = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("kassa-pos");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("pending_sales", "readonly");
    const all = await new Promise<unknown[]>((resolve, reject) => {
      const req = tx.objectStore("pending_sales").getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all as {
      localSaleId: string;
      outletId: string;
      status: string;
      lastError: string | null;
    }[];
  });
  const histogram: Record<string, number> = {};
  for (const r of audit) histogram[r.status] = (histogram[r.status] ?? 0) + 1;
  const nonSynced = audit.filter((r) => r.status !== "synced");
  if (audit.length === 0 || nonSynced.length > 0) {
    const sample = nonSynced
      .slice(0, 5)
      .map(
        (r) =>
          `  [${r.status}] ${r.localSaleId} (${r.outletId}): ${r.lastError ?? "(no error captured)"}`,
      )
      .join("\n");
    throw new Error(
      `pending_sales drain incomplete — total=${audit.length} status=${JSON.stringify(histogram)}. Non-synced sample:\n${sample || "  (none)"}`,
    );
  }
}

interface ServerSale {
  saleId: string;
  localSaleId: string;
  outletId: string;
  totalIdr: number;
  voidedAt: string | null;
  tenders: { method: string; amountIdr: number; reference: string | null }[];
  refunds: { id: string; amountIdr: number }[];
}

async function listSalesByDate(
  request: APIRequestContext,
  creds: DeviceCreds,
  outletId: string,
): Promise<ServerSale[]> {
  const url = new URL(`${HARNESS_BASE_URL}/v1/sales/`);
  url.searchParams.set("outletId", outletId);
  url.searchParams.set("businessDate", FIXTURE_BUSINESS_DATE);
  const resp = await request.get(url.toString(), {
    headers: deviceHeaders(creds),
  });
  expect(resp.ok(), `GET /v1/sales for ${outletId} returned ${resp.status()}`).toBeTruthy();
  const body = (await resp.json()) as { records: ServerSale[] };
  return body.records;
}

async function listLedger(
  request: APIRequestContext,
  creds: DeviceCreds,
  outletId: string,
): Promise<{ id: string; itemId: string; delta: number; reason: string }[]> {
  const url = new URL(`${HARNESS_BASE_URL}/v1/stock/ledger`);
  url.searchParams.set("outletId", outletId);
  url.searchParams.set("limit", "500");
  const resp = await request.get(url.toString(), { headers: deviceHeaders(creds) });
  expect(resp.ok(), `GET /v1/stock/ledger for ${outletId} returned ${resp.status()}`).toBeTruthy();
  const body = (await resp.json()) as {
    records: { id: string; itemId: string; delta: number; reason: string }[];
  };
  return body.records;
}

async function voidSale(
  request: APIRequestContext,
  creds: DeviceCreds,
  saleId: string,
): Promise<void> {
  // KASA-236-A added required `localVoidId` / `managerStaffId` / `managerPin`
  // wire fields. The e2e harness does not seed a `managerPinReader` or
  // `openShiftReader` on its `SalesService`, so the route accepts the body
  // but skips both gates — this keeps the full-day-offline acceptance test
  // exercising the void ledger / variance contract without dragging in the
  // shift open/close + staff seed dance owned by KASA-241 (KASA-236-C).
  const resp = await request.post(`${HARNESS_BASE_URL}/v1/sales/${saleId}/void`, {
    headers: { ...deviceHeaders(creds), "content-type": "application/json" },
    data: {
      localVoidId: newUuidV7(),
      managerStaffId: newUuidV7(),
      managerPin: "1234",
      voidedAt: new Date().toISOString(),
      voidBusinessDate: FIXTURE_BUSINESS_DATE,
      reason: "qa-suite",
    },
  });
  expect(resp.ok(), `void ${saleId} returned ${resp.status()}: ${await resp.text()}`).toBeTruthy();
}

async function refundSale(
  request: APIRequestContext,
  creds: DeviceCreds,
  sale: ServerSale,
): Promise<void> {
  // Build a refund payload: full amount, full lines.
  const detailResp = await request.get(`${HARNESS_BASE_URL}/v1/sales/${sale.saleId}`, {
    headers: deviceHeaders(creds),
  });
  expect(detailResp.ok()).toBeTruthy();
  const detail = (await detailResp.json()) as {
    items: { itemId: string; quantity: number }[];
    totalIdr: number;
  };
  const clientRefundId = newUuidV7();
  const resp = await request.post(`${HARNESS_BASE_URL}/v1/sales/${sale.saleId}/refund`, {
    headers: { ...deviceHeaders(creds), "content-type": "application/json" },
    data: {
      clientRefundId,
      refundedAt: new Date().toISOString(),
      refundBusinessDate: FIXTURE_BUSINESS_DATE,
      amountIdr: detail.totalIdr,
      lines: detail.items.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
      reason: "qa-suite",
    },
  });
  expect(
    resp.ok(),
    `refund ${sale.saleId} returned ${resp.status()}: ${await resp.text()}`,
  ).toBeTruthy();
}

async function closeEod(
  request: APIRequestContext,
  creds: DeviceCreds,
  outletId: string,
  submitted: SubmittedSale[],
  expectedCashIdr: number,
): Promise<{ varianceIdr: number; expectedCashIdr: number }> {
  const resp = await request.post(`${HARNESS_BASE_URL}/v1/eod/close`, {
    headers: { ...deviceHeaders(creds), "content-type": "application/json" },
    data: {
      outletId,
      businessDate: FIXTURE_BUSINESS_DATE,
      countedCashIdr: expectedCashIdr,
      varianceReason: null,
      clientSaleIds: submitted.map((s) => s.localSaleId),
    },
  });
  expect(
    resp.ok(),
    `eod close at ${outletId} returned ${resp.status()}: ${await resp.text()}`,
  ).toBeTruthy();
  return (await resp.json()) as { varianceIdr: number; expectedCashIdr: number };
}

function deviceHeaders(creds: DeviceCreds): Record<string, string> {
  return {
    "x-kassa-api-key": creds.apiKey,
    "x-kassa-api-secret": creds.apiSecret,
    accept: "application/json",
  };
}

function sumCashTenders(sales: SubmittedSale[]): number {
  return sum(sales.map((s) => s.cashIdr));
}

function sum(values: number[]): number {
  return values.reduce((acc, n) => acc + n, 0);
}

function newUuidV7(): string {
  // Quick test-only UUIDv7. Spec parser only enforces the shape.
  const ms = Date.now();
  const hex = ms.toString(16).padStart(12, "0");
  const rand = Math.random().toString(16).slice(2, 14).padEnd(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 12)}${"0".repeat(6)}`;
}
