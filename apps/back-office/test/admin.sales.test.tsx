import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AdminSalesScreen,
  applyClientFilters,
} from "../src/routes/admin.sales";
import { enumerateBusinessDays } from "../src/data/api/sales";
import { renderAt } from "./harness";
import { getSnapshot, resetStore } from "../src/data/store";
import { saveSession } from "../src/lib/session";
import type { SaleResponse } from "@kassa/schemas";

/*
 * KASA-249 — back-office /admin/sales sales-history page.
 *
 * Acceptance criteria covered here:
 *   1. Manager logged in sees today's sales by default.
 *   2. Widening the date range to last 7 days triggers a fan-out fetch
 *      across the (outletIds × days) window and shows more rows.
 *   3. Filter combinations narrow the rendered set; Clear filters
 *      restores the today view.
 *   4. Cashier role gets `<Forbidden />` instead of the sales table
 *      (router guard test — see role-gate case at the bottom).
 *   5. Row click opens the line-item + receipt-mirror detail panel.
 *
 * The harness mounts the screen in `id-ID` (DEFAULT_LOCALE), so the
 * user-visible strings asserted below are Indonesian.
 */

const FROZEN_NOW = new Date("2026-05-11T03:30:00.000+07:00").getTime();
const MERCHANT_ID = "11111111-1111-7111-8111-111111111111";

/*
 * The back-office seed uses Crockford-base32-style scaffold IDs
 * (`"01H000…OUTLET1"`). Those don't pass the server's strict UUIDv7
 * validation in `saleListResponse`, so every API fixture here uses
 * real UUIDv7 outlet/staff IDs and the store is reseeded to match.
 */
const OUTLET_PUSAT = "01890abc-1234-7def-8000-00000000aa01";
const OUTLET_PUSAT_NAME = "Warung Pusat";
const OUTLET_BANDUNG = "01890abc-1234-7def-8000-00000000aa02";
const OUTLET_BANDUNG_NAME = "Cabang Bandung";

const CASHIER_OWNER = "01890abc-1234-7def-8000-00000000cc01";
const CASHIER_OWNER_NAME = "Siti Rahayu";
const CASHIER_NIGHT = "01890abc-1234-7def-8000-00000000cc02";
const CASHIER_NIGHT_NAME = "Dewi Lestari";

const ITEM_UUID = "01890abc-1234-7def-8000-0000000017e1";
const UOM_UUID = "01890abc-1234-7def-8000-00000000c01d";

function seedUuidOutletsAndStaff(): void {
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
    staff: [
      {
        id: CASHIER_OWNER,
        displayName: CASHIER_OWNER_NAME,
        email: "siti@warungpusat.id",
        role: "owner",
        pin: "1234",
        isActive: true,
      },
      {
        id: CASHIER_NIGHT,
        displayName: CASHIER_NIGHT_NAME,
        email: "dewi@warungpusat.id",
        role: "cashier",
        pin: "5678",
        isActive: true,
      },
    ],
  });
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
  seedUuidOutletsAndStaff();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetStore();
});

function mkSale(overrides: Partial<SaleResponse> & { saleId: string }): SaleResponse {
  const base: SaleResponse = {
    saleId: overrides.saleId,
    name: "Sale",
    localSaleId: `01890abc-1234-7def-8000-${overrides.saleId.padStart(12, "0").slice(-12)}`,
    outletId: OUTLET_PUSAT,
    clerkId: CASHIER_OWNER,
    businessDate: "2026-05-11",
    subtotalIdr: 25_000,
    discountIdr: 0,
    totalIdr: 25_000,
    taxIdr: 0,
    items: [
      {
        itemId: ITEM_UUID,
        bomId: null,
        quantity: 1,
        uomId: UOM_UUID,
        unitPriceIdr: 25_000,
        lineTotalIdr: 25_000,
      },
    ],
    tenders: [
      {
        method: "cash" as const,
        amountIdr: 25_000,
        reference: null,
        verified: true,
      },
    ],
    createdAt: "2026-05-11T03:00:00.000+07:00",
    voidedAt: null,
    voidBusinessDate: null,
    voidReason: null,
    localVoidId: null,
    refunds: [],
  };
  return { ...base, ...overrides };
}

function mockFetchByQuery(map: (url: URL) => SaleResponse[]) {
  return vi.fn().mockImplementation((input: string) => {
    const url = new URL(input);
    const records = map(url);
    return Promise.resolve(
      new Response(JSON.stringify({ records }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

describe("applyClientFilters", () => {
  const records: SaleResponse[] = [
    mkSale({ saleId: "01890abc-1234-7def-8000-00000000a001" }),
    mkSale({
      saleId: "01890abc-1234-7def-8000-00000000a002",
      clerkId: CASHIER_NIGHT,
      tenders: [
        {
          method: "qris" as const,
          amountIdr: 25_000,
          reference: "MID-1",
          verified: true,
        },
      ],
    }),
    mkSale({
      saleId: "01890abc-1234-7def-8000-00000000a003",
      tenders: [
        {
          method: "qris_static" as const,
          amountIdr: 25_000,
          reference: null,
          buyerRefLast4: "1234",
          verified: false,
        },
      ],
    }),
  ];

  it("returns all records when no filters set", () => {
    const out = applyClientFilters(records, { tenders: [], cashierIds: [] });
    expect(out).toHaveLength(3);
  });

  it("narrows by tender method (UI key maps qris_dynamic to wire 'qris')", () => {
    const out = applyClientFilters(records, {
      tenders: ["qris_dynamic"],
      cashierIds: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.saleId).toBe("01890abc-1234-7def-8000-00000000a002");
  });

  it("narrows by cashier id", () => {
    const out = applyClientFilters(records, {
      tenders: [],
      cashierIds: [CASHIER_NIGHT],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.clerkId).toBe(CASHIER_NIGHT);
  });

  it("ANDs tender and cashier filters", () => {
    const out = applyClientFilters(records, {
      tenders: ["cash"],
      cashierIds: [CASHIER_NIGHT],
    });
    expect(out).toHaveLength(0);
  });
});

describe("enumerateBusinessDays", () => {
  it("walks inclusive days", () => {
    expect(enumerateBusinessDays("2026-05-09", "2026-05-11")).toEqual([
      "2026-05-09",
      "2026-05-10",
      "2026-05-11",
    ]);
  });

  it("returns an empty list for an inverted range", () => {
    expect(enumerateBusinessDays("2026-05-11", "2026-05-09")).toEqual([]);
  });

  it("returns a single day for from === to", () => {
    expect(enumerateBusinessDays("2026-05-11", "2026-05-11")).toEqual(["2026-05-11"]);
  });
});

describe("AdminSalesScreen", () => {
  it("renders today's sales by default and calls GET /v1/sales with today's businessDate", async () => {
    const fetchMock = mockFetchByQuery((url) => {
      if (
        url.searchParams.get("businessDate") === "2026-05-11" &&
        url.searchParams.get("outletId") === OUTLET_PUSAT
      ) {
        return [
          mkSale({ saleId: "01890abc-1234-7def-8000-00000000b001" }),
          mkSale({
            saleId: "01890abc-1234-7def-8000-00000000b002",
            clerkId: CASHIER_NIGHT,
          }),
        ];
      }
      return [];
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/sales", [{ path: "/admin/sales", component: AdminSalesScreen }]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/v1/sales"))).toBe(true);
    expect(urls.some((u) => u.includes("businessDate=2026-05-11"))).toBe(true);
    expect(urls.some((u) => u.includes(`outletId=${OUTLET_PUSAT}`))).toBe(true);
    expect(urls.some((u) => u.includes(`outletId=${OUTLET_BANDUNG}`))).toBe(true);

    await waitFor(() => {
      expect(screen.queryAllByTestId("data-table-row")).toHaveLength(2);
    });
  });

  it("widens the date range to last 7 days and refetches per-day", async () => {
    const seen: string[] = [];
    const fetchMock = mockFetchByQuery((url) => {
      const businessDate = url.searchParams.get("businessDate") ?? "";
      const outletId = url.searchParams.get("outletId") ?? "";
      seen.push(businessDate);
      if (businessDate === "2026-05-11" && outletId === OUTLET_PUSAT) {
        return [mkSale({ saleId: "01890abc-1234-7def-8000-00000000c001" })];
      }
      if (businessDate === "2026-05-09" && outletId === OUTLET_PUSAT) {
        return [
          mkSale({
            saleId: "01890abc-1234-7def-8000-00000000c002",
            businessDate: "2026-05-09",
            createdAt: "2026-05-09T03:00:00.000+07:00",
          }),
        ];
      }
      return [];
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/sales", [{ path: "/admin/sales", component: AdminSalesScreen }]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const fromInput = screen.getByLabelText("Dari tanggal") as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2026-05-05" } });

    await waitFor(() => expect(seen).toContain("2026-05-05"));
    expect(seen).toContain("2026-05-06");
    expect(seen).toContain("2026-05-07");
    expect(seen).toContain("2026-05-09");
    expect(seen).toContain("2026-05-11");
    await waitFor(() => {
      expect(screen.queryAllByTestId("data-table-row").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("filters by tender method and restores via clear-filters", async () => {
    const fetchMock = mockFetchByQuery((url) => {
      if (
        url.searchParams.get("businessDate") === "2026-05-11" &&
        url.searchParams.get("outletId") === OUTLET_PUSAT
      ) {
        return [
          mkSale({ saleId: "01890abc-1234-7def-8000-00000000d001" }),
          mkSale({
            saleId: "01890abc-1234-7def-8000-00000000d002",
            tenders: [
              {
                method: "qris" as const,
                amountIdr: 25_000,
                reference: "MID-1",
                verified: true,
              },
            ],
          }),
        ];
      }
      return [];
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/sales", [{ path: "/admin/sales", component: AdminSalesScreen }]);
    await waitFor(() => {
      expect(screen.queryAllByTestId("data-table-row")).toHaveLength(2);
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Tunai"));
    await waitFor(() => {
      expect(screen.queryAllByTestId("data-table-row")).toHaveLength(1);
    });

    await user.click(screen.getByRole("button", { name: "Bersihkan filter" }));
    await waitFor(() => {
      expect(screen.queryAllByTestId("data-table-row")).toHaveLength(2);
    });
  });

  it("opens the line-item + receipt-mirror panel when a row is clicked", async () => {
    const fetchMock = mockFetchByQuery((url) => {
      if (url.searchParams.get("outletId") === OUTLET_PUSAT) {
        return [mkSale({ saleId: "01890abc-1234-7def-8000-00000000e001" })];
      }
      return [];
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/sales", [{ path: "/admin/sales", component: AdminSalesScreen }]);
    await waitFor(() => {
      expect(screen.queryAllByTestId("data-table-row")).toHaveLength(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("data-table-row"));
    const panel = await screen.findByTestId("sale-detail-panel");
    expect(within(panel).getByText("Detail item")).toBeInTheDocument();
    expect(within(panel).getByLabelText("receipt-mirror")).toBeInTheDocument();
    expect(within(panel).getByText(OUTLET_PUSAT_NAME)).toBeInTheDocument();
  });

  it("renders the role-gated forbidden screen for a cashier session", async () => {
    saveSession({
      email: "dewi@warungpusat.id",
      displayName: "Dewi Lestari",
      role: "cashier",
      merchantId: MERCHANT_ID,
      issuedAt: new Date(FROZEN_NOW).toISOString(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { roleCanManage, loadSession } = await import("../src/lib/session");
    const { Forbidden } = await import("../src/components/Forbidden");
    const session = loadSession()!;

    renderAt("/admin/sales", [
      {
        path: "/admin/sales",
        component: () => (roleCanManage(session.role) ? <AdminSalesScreen /> : <Forbidden />),
      },
    ]);
    expect(
      await screen.findByRole("heading", { name: "Akses dibatasi" }),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an inline error when GET /v1/sales returns 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/admin/sales", [{ path: "/admin/sales", component: AdminSalesScreen }]);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Akses dibatasi|Gagal/);
  });
});
