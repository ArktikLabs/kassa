import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { IntlProvider } from "../../i18n/IntlProvider";
import { getDatabase, _resetDatabaseSingletonForTest } from "../../data/db/index.ts";
import { DB_NAME } from "../../data/db/schema.ts";
import { toRupiah } from "../../shared/money/index.ts";
import { _resetForTest as resetEnrolmentForTest, hydrateEnrolment } from "../../lib/enrolment.ts";
import { EodScreen } from "./EodScreen.tsx";

/*
 * These tests drive the full /eod screen against real Dexie (fake-indexeddb)
 * and a stubbed `fetch` for `/v1/eod/close`. They cover the four scenarios
 * the acceptance criteria call out: zero-variance close, cash-short close
 * with reason, pre-close queue drain, and the missing-sale guard.
 */

const OUTLET_ID = "01890abc-1234-7def-8000-000000000001";
const MERCHANT_ID = "01890abc-1234-7def-8000-000000000010";
const DEVICE_ID = "01890abc-1234-7def-8000-000000000020";
const CLERK_ID = DEVICE_ID;
const BUSINESS_DATE = "2026-04-23";
const NOW = new Date("2026-04-23T05:00:00.000Z"); // 12:00 WIB

function makeSale(overrides: {
  id: string;
  totalIdr: number;
  method?: "cash" | "qris" | "card" | "other";
  status?: "queued" | "synced" | "error" | "needs_attention" | "sending";
}) {
  const method = overrides.method ?? "cash";
  return {
    localSaleId: overrides.id,
    outletId: OUTLET_ID,
    clerkId: CLERK_ID,
    businessDate: BUSINESS_DATE,
    createdAt: "2026-04-23T03:00:00.000Z",
    subtotalIdr: toRupiah(overrides.totalIdr),
    discountIdr: toRupiah(0),
    totalIdr: toRupiah(overrides.totalIdr),
    items: [],
    tenders: [
      {
        method,
        amountIdr: toRupiah(overrides.totalIdr),
        reference: null,
      },
    ],
    status: overrides.status ?? "synced",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    serverSaleName: null,
  };
}

async function seedDatabase(sales: ReturnType<typeof makeSale>[]): Promise<void> {
  const db = await getDatabase();
  await db.repos.deviceSecret.set({
    deviceId: DEVICE_ID,
    outletId: OUTLET_ID,
    outletName: "Warung Bu Tini",
    merchantId: MERCHANT_ID,
    merchantName: "Warung Bu Tini HQ",
    apiKey: "ak",
    apiSecret: "as",
    enrolledAt: "2026-04-23T00:00:00.000Z",
  });
  await db.repos.outlets.upsertMany([
    {
      id: OUTLET_ID,
      code: "OUT-1",
      name: "Warung Bu Tini",
      timezone: "Asia/Jakarta",
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
  ]);
  for (const sale of sales) {
    await db.db.pending_sales.put(sale);
  }
  // Populate the module-level snapshot so `handleSubmit` sees an enrolled
  // device without the live store wiring the shell does at boot.
  await hydrateEnrolment();
}

function renderScreen(): ReturnType<typeof render> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const eodRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/eod",
    component: EodScreen,
  });
  const tree = rootRoute.addChildren([eodRoute]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ["/eod"] }),
  });
  return render(
    <IntlProvider locale="id-ID">
      <RouterProvider router={router} />
    </IntlProvider>,
  );
}

async function tapKeys(digits: string): Promise<void> {
  const user = userEvent.setup();
  for (const d of digits) {
    const btn = screen.getByRole("button", { name: new RegExp(`^${d}$`) });
    await user.click(btn);
  }
}

describe("EodScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    _resetDatabaseSingletonForTest();
    resetEnrolmentForTest();
    await Dexie.delete(DB_NAME);
    vi.restoreAllMocks();
  });

  it("zero-variance close: renders totals, posts and flips to the closed summary", async () => {
    await seedDatabase([
      makeSale({ id: "01890abc-1234-7def-8000-000000000101", totalIdr: 25_000 }),
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          eodId: "01890abc-1234-7def-8000-00000000ee01",
          outletId: OUTLET_ID,
          businessDate: BUSINESS_DATE,
          closedAt: "2026-04-23T18:00:00+07:00",
          countedCashIdr: 25_000,
          expectedCashIdr: 25_000,
          varianceIdr: 0,
          varianceReason: null,
          breakdown: {
            saleCount: 1,
            voidCount: 0,
            cashIdr: 25_000,
            qrisDynamicIdr: 0,
            qrisStaticIdr: 0,
            qrisStaticUnverifiedIdr: 0,
            cardIdr: 0,
            otherIdr: 0,
            netIdr: 25_000,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    renderScreen();
    await screen.findByTestId("eod-screen");
    await waitFor(() => expect(screen.getByTestId("eod-cash").textContent).toMatch(/25/));
    expect(screen.getByTestId("eod-sale-count").textContent).toBe("1");

    await act(async () => {
      await tapKeys("25000");
    });
    await act(async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByTestId("eod-submit"));
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => screen.getByTestId("eod-closed"));
    expect(screen.getByTestId("eod-closed-counted").textContent).toMatch(/25/);

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.countedCashIdr).toBe(25_000);
    expect(body.varianceReason).toBeNull();
    expect(body.clientSaleIds).toEqual(["01890abc-1234-7def-8000-000000000101"]);
  });

  it("cash-short close: requires a reason and submits it", async () => {
    await seedDatabase([
      makeSale({ id: "01890abc-1234-7def-8000-000000000201", totalIdr: 50_000 }),
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          eodId: "01890abc-1234-7def-8000-00000000ee02",
          outletId: OUTLET_ID,
          businessDate: BUSINESS_DATE,
          closedAt: "2026-04-23T18:00:00+07:00",
          countedCashIdr: 40_000,
          expectedCashIdr: 50_000,
          varianceIdr: -10_000,
          varianceReason: "kembalian",
          breakdown: {
            saleCount: 1,
            voidCount: 0,
            cashIdr: 50_000,
            qrisDynamicIdr: 0,
            qrisStaticIdr: 0,
            qrisStaticUnverifiedIdr: 0,
            cardIdr: 0,
            otherIdr: 0,
            netIdr: 50_000,
          },
        }),
        { status: 201 },
      ),
    );

    renderScreen();
    await screen.findByTestId("eod-screen");
    await waitFor(() => expect(screen.getByTestId("eod-cash").textContent).toMatch(/50/));

    await act(async () => {
      await tapKeys("40000");
    });
    // Variance = −10.000, button is disabled until reason is filled.
    await waitFor(() => {
      expect(screen.getByTestId("eod-variance").textContent).toMatch(/10\.000/);
    });
    const submit = screen.getByTestId("eod-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => {
      await user.type(screen.getByTestId("eod-reason"), "kembalian");
    });

    await waitFor(() => {
      expect((screen.getByTestId("eod-submit") as HTMLButtonElement).disabled).toBe(false);
    });

    await act(async () => {
      await user.click(screen.getByTestId("eod-submit"));
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.countedCashIdr).toBe(40_000);
    expect(body.varianceReason).toBe("kembalian");
  });

  it("pre-close queue drain: button disabled while outbox is not empty", async () => {
    await seedDatabase([
      makeSale({
        id: "01890abc-1234-7def-8000-000000000301",
        totalIdr: 10_000,
        status: "queued",
      }),
    ]);

    renderScreen();
    await screen.findByTestId("eod-screen");
    const submit = (await screen.findByTestId("eod-submit")) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("eod-outbox-status").textContent).toMatch(/1/);
    });
  });

  it("missing-sale guard: surfaces the count and enables Kirim ulang", async () => {
    await seedDatabase([
      makeSale({ id: "01890abc-1234-7def-8000-000000000401", totalIdr: 10_000 }),
    ]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "eod_sale_mismatch",
            message: "1 sale(s) missing",
            details: {
              expectedCount: 1,
              receivedCount: 0,
              missingSaleIds: ["01890abc-1234-7def-8000-000000000401"],
            },
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );

    renderScreen();
    await screen.findByTestId("eod-screen");
    await act(async () => {
      await tapKeys("10000");
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => {
      await user.click(screen.getByTestId("eod-submit"));
    });
    await waitFor(() => screen.getByTestId("eod-mismatch"));
    expect(screen.getByTestId("eod-mismatch").textContent).toMatch(/1/);
    expect(screen.getByTestId("eod-resubmit")).toBeInTheDocument();
  });
});
