import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminDashboardScreen } from "../src/routes/admin.dashboard";
import { renderAt } from "./harness";
import { saveSession } from "../src/lib/session";

/*
 * KASA-237 — back-office /admin/dashboard.
 *
 * Pinned behaviour:
 *   1. Owner with multiple outlets sees the outlet pill defaulting to
 *      "Semua outlet" and posts an unscoped fetch.
 *   2. Tiles + tender mix + leaderboards render the API response.
 *   3. Switching the date scope ("Hari ini" → "7 hari") refetches with the
 *      new window.
 *   4. saleCount === 0 renders the "Belum ada penjualan" empty state, not
 *      "Rp 0" tiles.
 *   5. Single-outlet sessions hide the outlet pill (per AC: "manager
 *      scoped to one outlet does not see the selector at all").
 */

const FROZEN_NOW = new Date("2026-04-25T10:00:00.000+07:00").getTime();

function buildSummary(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    outletId: null,
    from: "2026-04-25",
    to: "2026-04-25",
    grossIdr: 63_750,
    taxIdr: 6_315,
    netIdr: 57_435,
    saleCount: 2,
    averageTicketIdr: 31_875,
    tenderMix: [
      { method: "qris_dynamic", amountIdr: 36_000, count: 1 },
      { method: "cash", amountIdr: 27_750, count: 1 },
    ],
    topItemsByRevenue: [
      {
        itemId: "01890abc-1234-7def-8000-0000000c0001",
        name: "Kopi Susu",
        revenueIdr: 54_000,
        quantity: 3,
      },
      {
        itemId: "01890abc-1234-7def-8000-0000000c0002",
        name: "Roti Bakar",
        revenueIdr: 9_750,
        quantity: 1,
      },
    ],
    topItemsByQuantity: [
      {
        itemId: "01890abc-1234-7def-8000-0000000c0001",
        name: "Kopi Susu",
        revenueIdr: 54_000,
        quantity: 3,
      },
    ],
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
    merchantId: "11111111-1111-7111-8111-111111111111",
    issuedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Admin dashboard", () => {
  it("renders headline tiles, tender mix, and leaderboards from the API", async () => {
    const fetchMock = mockFetchOk(buildSummary());
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/dashboard", [{ path: "/admin/dashboard", component: AdminDashboardScreen }]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("dashboard-tile-gross")).toHaveTextContent("63.750");
    expect(screen.getByTestId("dashboard-tile-net")).toHaveTextContent("57.435");
    expect(screen.getByTestId("dashboard-tile-sale-count")).toHaveTextContent("2");
    expect(screen.getByTestId("dashboard-tile-average-ticket")).toHaveTextContent("31.875");

    expect(screen.getByTestId("dashboard-tender-cash")).toHaveTextContent("27.750");
    expect(screen.getByTestId("dashboard-tender-qris_dynamic")).toHaveTextContent("36.000");

    expect(screen.getByTestId("dashboard-top-revenue")).toHaveTextContent("Kopi Susu");
    expect(screen.getByTestId("dashboard-top-quantity")).toHaveTextContent("Kopi Susu");
  });

  it("calls the dashboard endpoint with the today window by default", async () => {
    const fetchMock = mockFetchOk(buildSummary());
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/dashboard", [{ path: "/admin/dashboard", component: AdminDashboardScreen }]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/reports/dashboard");
    expect(String(url)).toContain("from=2026-04-25");
    expect(String(url)).toContain("to=2026-04-25");
    expect(String(url)).not.toContain("outletId=");
  });

  it("refetches with a wider window when '7 hari' is selected", async () => {
    const fetchMock = mockFetchOk(buildSummary());
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/dashboard", [{ path: "/admin/dashboard", component: AdminDashboardScreen }]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const user = userEvent.setup();
    await user.click(screen.getByTestId("dashboard-scope-last_7_days"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url] = fetchMock.mock.calls[1]!;
    expect(String(url)).toContain("from=2026-04-19");
    expect(String(url)).toContain("to=2026-04-25");
  });

  it("renders the empty state instead of Rp 0 when no sales today", async () => {
    const fetchMock = mockFetchOk(
      buildSummary({
        grossIdr: 0,
        taxIdr: 0,
        netIdr: 0,
        saleCount: 0,
        averageTicketIdr: 0,
        tenderMix: [],
        topItemsByRevenue: [],
        topItemsByQuantity: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/dashboard", [{ path: "/admin/dashboard", component: AdminDashboardScreen }]);

    await waitFor(() => expect(screen.getByTestId("dashboard-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("dashboard-tile-gross")).not.toBeInTheDocument();
    expect(screen.getByText("Belum ada penjualan")).toBeInTheDocument();
  });

  it("hides the outlet selector for single-outlet sessions", async () => {
    const fetchMock = mockFetchOk(buildSummary());
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/dashboard", [{ path: "/admin/dashboard", component: AdminDashboardScreen }]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("dashboard-outlet-select")).not.toBeInTheDocument();
  });

  it("surfaces an inline error when the dashboard call fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/dashboard", [{ path: "/admin/dashboard", component: AdminDashboardScreen }]);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Akses dibatasi|Gagal/);
  });
});
