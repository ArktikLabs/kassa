import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { CashierDayResponse } from "@kassa/schemas/reports";
import { AdminCashierDayScreen } from "../src/routes/admin.reports.cashier-day";
import { renderAt } from "./harness";
import { getSnapshot, resetStore } from "../src/data/store";
import { saveSession } from "../src/lib/session";

/*
 * KASA-368 — back-office /reports/cashier-day page.
 *
 * Pinned behaviour:
 *   1. Default fetch goes against today + first managed outlet.
 *   2. Per-cashier rows + totals card render the response.
 *   3. Changing the date triggers a refetch with the new businessDate.
 *   4. Empty-state copy renders when `rows: []`, and the CSV button is
 *      disabled (no anchor href — no risk of an empty download).
 *   5. CSV download link points at the server-rendered
 *      `/v1/reports/cashier-day/export.csv` with the same query.
 */

const FROZEN_NOW = new Date("2026-05-29T03:30:00.000+07:00").getTime();
const MERCHANT_ID = "11111111-1111-7111-8111-111111111111";

const OUTLET_PUSAT = "01890abc-1234-7def-8000-00000000aa01";
const OUTLET_PUSAT_NAME = "Warung Pusat";
const OUTLET_BANDUNG = "01890abc-1234-7def-8000-00000000aa02";
const OUTLET_BANDUNG_NAME = "Cabang Bandung";

const CASHIER_SITI = "01890abc-1234-7def-8000-00000000cc01";
const CASHIER_DEWI = "01890abc-1234-7def-8000-00000000cc02";

function seedTwoOutlets(): void {
  const current = getSnapshot();
  resetStore({
    ...current,
    outlets: [
      {
        id: OUTLET_PUSAT,
        name: OUTLET_PUSAT_NAME,
        taxProfile: "none",
        receiptHeader: "Warung Pusat",
        addressLine: "Jl. Sudirman No.1",
      },
      {
        id: OUTLET_BANDUNG,
        name: OUTLET_BANDUNG_NAME,
        taxProfile: "ppn_11",
        receiptHeader: "Cabang Bandung",
        addressLine: "Jl. Asia Afrika No.7",
      },
    ],
  });
}

function buildReport(overrides: Partial<CashierDayResponse> = {}): CashierDayResponse {
  return {
    outletId: OUTLET_PUSAT,
    businessDate: "2026-05-29",
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
    ...overrides,
  };
}

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(FROZEN_NOW);
  vi.stubEnv("VITE_API_BASE_URL", "https://api.kassa.test");
  saveSession({
    email: "siti@warungpusat.id",
    displayName: "Siti Rahayu",
    role: "owner",
    merchantId: MERCHANT_ID,
    issuedAt: new Date(FROZEN_NOW).toISOString(),
  });
  seedTwoOutlets();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetStore();
});

describe("AdminCashierDayScreen", () => {
  it("renders per-cashier rows and the totals card from the API", async () => {
    const fetchMock = mockFetchOk(buildReport());
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/reports/cashier-day", [
      { path: "/reports/cashier-day", component: AdminCashierDayScreen },
    ]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/reports/cashier-day");
    expect(String(url)).toContain(`outletId=${OUTLET_PUSAT}`);
    expect(String(url)).toContain("businessDate=2026-05-29");

    await waitFor(() => {
      expect(screen.getByText("Siti Rahayu")).toBeInTheDocument();
      expect(screen.getByText("Dewi Lestari")).toBeInTheDocument();
    });

    const totals = screen.getByTestId("cashier-day-totals");
    expect(totals).toHaveTextContent("9");
    // 195.500 (gross), 186.500 (net), 122.000 (cash total), 143.000 (drawer)
    expect(totals).toHaveTextContent("195.500");
    expect(totals).toHaveTextContent("186.500");
    expect(totals).toHaveTextContent("122.000");
    expect(totals).toHaveTextContent("143.000");
  });

  it("refetches when the date filter changes", async () => {
    const fetchMock = mockFetchOk(buildReport());
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/reports/cashier-day", [
      { path: "/reports/cashier-day", component: AdminCashierDayScreen },
    ]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const dateInput = screen.getByLabelText("Tanggal") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-05-28" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url] = fetchMock.mock.calls[1]!;
    expect(String(url)).toContain("businessDate=2026-05-28");
  });

  it("renders the empty state and disables CSV export when no cashier sold", async () => {
    const fetchMock = mockFetchOk(
      buildReport({
        rows: [],
        totals: {
          saleCount: 0,
          grossIdr: 0,
          netIdr: 0,
          voidCount: 0,
          voidIdr: 0,
          tenderMix: [],
          drawerExpectedIdr: null,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/reports/cashier-day", [
      { path: "/reports/cashier-day", component: AdminCashierDayScreen },
    ]);

    await waitFor(() => expect(screen.getByTestId("cashier-day-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("cashier-day-totals")).not.toBeInTheDocument();
    expect(screen.getByTestId("cashier-day-export-csv-disabled")).toBeDisabled();
    expect(screen.queryByTestId("cashier-day-export-csv")).not.toBeInTheDocument();
  });

  it("renders the CSV export link with the same outlet+date as the JSON query", async () => {
    const fetchMock = mockFetchOk(buildReport());
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/reports/cashier-day", [
      { path: "/reports/cashier-day", component: AdminCashierDayScreen },
    ]);

    const link = (await screen.findByTestId("cashier-day-export-csv")) as HTMLAnchorElement;
    expect(link.href).toContain("/v1/reports/cashier-day/export.csv");
    expect(link.href).toContain(`outletId=${OUTLET_PUSAT}`);
    expect(link.href).toContain("businessDate=2026-05-29");
  });

  it("surfaces an inline error when the API returns 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/reports/cashier-day", [
      { path: "/reports/cashier-day", component: AdminCashierDayScreen },
    ]);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Akses dibatasi|Gagal/);
  });
});
