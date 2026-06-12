import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE, messagesFor } from "../../i18n/messages.ts";
import { _resetDatabaseSingletonForTest, DB_NAME, getDatabase } from "../../data/db/index.ts";
import { _resetForTest as resetEnrolmentForTest } from "../../lib/enrolment.ts";
import { toRupiah } from "../../shared/money/index.ts";
import type { PendingSale, ShiftState } from "../../data/db/types.ts";
import { FindSaleScreen, reduceFindSale, type FindSaleState } from "./FindSaleScreen.tsx";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    className,
    ...rest
  }: React.PropsWithChildren<{ to: string; className?: string; [key: string]: unknown }>) => (
    <a href={to} className={className} {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
}));

const locale = DEFAULT_LOCALE;
const messages = messagesFor(locale);

function renderScreen() {
  return render(
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      <FindSaleScreen />
    </IntlProvider>,
  );
}

async function seedEnrolment() {
  const { repos } = await getDatabase();
  await repos.deviceSecret.set({
    deviceId: "device-1",
    apiKey: "key",
    apiSecret: "secret",
    outletId: "outlet-a",
    outletName: "Warung Maju",
    merchantId: "merchant-1",
    merchantName: "Merchant",
    enrolledAt: "2026-05-29T00:00:00.000Z",
  });
}

async function seedShift(overrides: Partial<Omit<ShiftState, "id">> = {}) {
  const { repos } = await getDatabase();
  await repos.shiftState.put({
    localShiftId: overrides.localShiftId ?? "shift-1",
    outletId: overrides.outletId ?? "outlet-a",
    cashierStaffId: overrides.cashierStaffId ?? "cashier-1",
    businessDate: overrides.businessDate ?? "2026-05-29",
    openShiftId: overrides.openShiftId ?? "shift-1",
    openedAt: overrides.openedAt ?? "2026-05-29T08:00:00.000Z",
    openingFloatIdr: overrides.openingFloatIdr ?? 100_000,
    serverShiftId: overrides.serverShiftId ?? null,
    closedAt: overrides.closedAt ?? null,
  });
}

async function seedSale(
  localSaleId: string,
  overrides: Partial<PendingSale> = {},
): Promise<PendingSale> {
  const { repos } = await getDatabase();
  const total = overrides.totalIdr ?? toRupiah(25_000);
  const sale = await repos.pendingSales.enqueue({
    localSaleId,
    outletId: overrides.outletId ?? "outlet-a",
    clerkId: overrides.clerkId ?? "cashier-1",
    businessDate: overrides.businessDate ?? "2026-05-29",
    createdAt: overrides.createdAt ?? "2026-05-29T09:00:00.000Z",
    subtotalIdr: overrides.subtotalIdr ?? total,
    discountIdr: overrides.discountIdr ?? toRupiah(0),
    totalIdr: total,
    items: overrides.items ?? [
      {
        itemId: "item-1",
        bomId: null,
        quantity: 1,
        uomId: "uom-cup",
        unitPriceIdr: total,
        lineTotalIdr: total,
      },
    ],
    tenders: overrides.tenders ?? [{ method: "cash", amountIdr: total, reference: null }],
  });
  if (overrides.serverSaleId !== undefined || overrides.serverSaleName !== undefined) {
    await repos.pendingSales.markSynced(
      localSaleId,
      {
        name: overrides.serverSaleName ?? "SALE-0001",
        saleId: overrides.serverSaleId ?? "server-sale-1",
      },
      "2026-05-29T09:00:01.000Z",
    );
  }
  if (overrides.voidedAt) {
    await repos.pendingSales.markVoided(localSaleId, {
      voidedAt: overrides.voidedAt,
      voidBusinessDate: overrides.voidBusinessDate ?? "2026-05-29",
      voidReason: overrides.voidReason ?? null,
      voidLocalId: overrides.voidLocalId ?? "void-1",
    });
  }
  return sale;
}

describe("reduceFindSale", () => {
  const baseSale: PendingSale = {
    localSaleId: "018f9c1a-4b2e-7c00-b000-000000abc123",
    outletId: "outlet-a",
    clerkId: "cashier-1",
    businessDate: "2026-05-29",
    createdAt: "2026-05-29T09:00:00.000Z",
    subtotalIdr: toRupiah(25_000),
    discountIdr: toRupiah(0),
    totalIdr: toRupiah(25_000),
    items: [],
    tenders: [],
    status: "synced",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    serverSaleName: "SALE-0001",
    serverSaleId: "server-sale-1",
    voidedAt: null,
    voidBusinessDate: null,
    voidReason: null,
    voidLocalId: null,
  };

  it("submit → searching", () => {
    const next: FindSaleState = reduceFindSale({ kind: "idle" }, { type: "submit" });
    expect(next.kind).toBe("searching");
  });

  it("submit_remote → searching_remote (KASA-370 server fallback hint)", () => {
    const next = reduceFindSale({ kind: "searching" }, { type: "submit_remote" });
    expect(next.kind).toBe("searching_remote");
  });

  it("found carries the sale + shift snapshot", () => {
    const next = reduceFindSale(
      { kind: "searching" },
      { type: "found", sale: baseSale, shift: null },
    );
    expect(next).toEqual({ kind: "found", sale: baseSale, shift: null });
  });

  it("not_found carries the normalised code so the dead-end can echo it back", () => {
    const next = reduceFindSale({ kind: "searching" }, { type: "not_found", code: "ABC123" });
    expect(next).toEqual({ kind: "not_found", code: "ABC123" });
  });

  it("reset clears any prior result", () => {
    const next = reduceFindSale({ kind: "found", sale: baseSale, shift: null }, { type: "reset" });
    expect(next).toEqual({ kind: "idle" });
  });
});

describe("<FindSaleScreen />", () => {
  // The screen now performs a KASA-370 server fallback after a Dexie miss
  // when the device is online. The default test environment is "offline"
  // so the existing same-device assertions stay deterministic — tests
  // that exercise the network branch set `setNavigatorOnLine(true)` and
  // stub fetch with `stubFetch(...)`.
  let originalOnLine: PropertyDescriptor | undefined;
  let fetchMock: ReturnType<typeof vi.fn> | null = null;

  function setNavigatorOnLine(value: boolean): void {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => value,
    });
  }

  function stubFetch(impl: typeof fetch): void {
    fetchMock = vi.fn(impl) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock);
  }

  beforeEach(() => {
    resetEnrolmentForTest();
    navigateMock.mockReset();
    originalOnLine = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator) ?? navigator,
      "onLine",
    );
    setNavigatorOnLine(false);
    fetchMock = null;
  });

  afterEach(async () => {
    _resetDatabaseSingletonForTest();
    // Purge the actual IDB store too — KASA-370 hydrates a `synced` row
    // into Dexie on a remote hit, and without a delete the row would
    // leak into subsequent tests and short-circuit the lookup.
    await Dexie.delete(DB_NAME);
    resetEnrolmentForTest();
    if (originalOnLine) {
      Object.defineProperty(navigator, "onLine", originalOnLine);
    }
    vi.unstubAllGlobals();
    fetchMock = null;
  });

  it("warns when the device is not enrolled", async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId("find-sale-unenrolled")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("find-sale-form")).toBeNull();
  });

  it("shows the not-found dead-end when no sale matches the receipt code", async () => {
    await seedEnrolment();
    await seedShift();
    await seedSale("018f9c1a-4b2e-7c00-b000-000000abc123");
    renderScreen();

    const input = await screen.findByTestId("find-sale-input");
    const user = userEvent.setup();
    await user.type(input, "999999");
    await user.click(screen.getByTestId("find-sale-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("find-sale-not-found")).toBeInTheDocument();
    });
  });

  it("rejects malformed input without hitting Dexie", async () => {
    await seedEnrolment();
    await seedShift();
    renderScreen();

    const input = await screen.findByTestId("find-sale-input");
    const user = userEvent.setup();
    await user.type(input, "12");
    await user.click(screen.getByTestId("find-sale-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("find-sale-format-error")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("find-sale-summary")).toBeNull();
  });

  it("resolves a sale by receipt code and renders the summary card with both CTAs enabled", async () => {
    await seedEnrolment();
    await seedShift({ businessDate: "2026-05-29" });
    await seedSale("018f9c1a-4b2e-7c00-b000-000000abc123", {
      businessDate: "2026-05-29",
      serverSaleId: "server-sale-1",
    });
    renderScreen();

    const input = await screen.findByTestId("find-sale-input");
    const user = userEvent.setup();
    // Mixed case + a hyphen — the normaliser must strip both.
    await user.type(input, "abc-123");
    await user.click(screen.getByTestId("find-sale-submit"));

    const summary = await screen.findByTestId("find-sale-summary");
    expect(summary).toHaveAttribute("data-local-sale-id", "018f9c1a-4b2e-7c00-b000-000000abc123");
    expect(screen.getByTestId("find-sale-summary-code")).toHaveTextContent("ABC123");
    expect(screen.getByTestId("find-sale-summary-confirmed")).toBeInTheDocument();
    expect(screen.getByTestId("find-sale-reprint")).not.toBeDisabled();
    expect(screen.getByTestId("find-sale-void")).not.toBeDisabled();
  });

  it("disables Void with a clear hint when the sale is outside the active shift", async () => {
    await seedEnrolment();
    await seedShift({ businessDate: "2026-05-29" });
    await seedSale("018f9c1a-4b2e-7c00-b000-000000abc123", {
      businessDate: "2026-05-28", // prior day, outside the open shift
      serverSaleId: "server-sale-1",
    });
    renderScreen();

    const input = await screen.findByTestId("find-sale-input");
    const user = userEvent.setup();
    await user.type(input, "abc123");
    await user.click(screen.getByTestId("find-sale-submit"));

    await screen.findByTestId("find-sale-summary");
    expect(screen.getByTestId("find-sale-reprint")).not.toBeDisabled();
    expect(screen.getByTestId("find-sale-void")).toBeDisabled();
    expect(screen.getByTestId("find-sale-void-blocked")).toBeInTheDocument();
  });

  it("disables Reprint and surfaces a Dibatalkan badge for an already-voided sale", async () => {
    await seedEnrolment();
    await seedShift();
    await seedSale("018f9c1a-4b2e-7c00-b000-000000abc123", {
      serverSaleId: "server-sale-1",
      voidedAt: "2026-05-29T09:15:00.000Z",
    });
    renderScreen();

    const input = await screen.findByTestId("find-sale-input");
    const user = userEvent.setup();
    await user.type(input, "ABC123");
    await user.click(screen.getByTestId("find-sale-submit"));

    await screen.findByTestId("find-sale-summary");
    expect(screen.getByTestId("find-sale-summary-voided")).toBeInTheDocument();
    expect(screen.getByTestId("find-sale-reprint")).toBeDisabled();
    expect(screen.getByTestId("find-sale-void")).toBeDisabled();
  });

  it("navigates into /sales/$id when Reprint is clicked", async () => {
    await seedEnrolment();
    await seedShift();
    await seedSale("018f9c1a-4b2e-7c00-b000-000000abc123", {
      serverSaleId: "server-sale-1",
    });
    renderScreen();

    const input = await screen.findByTestId("find-sale-input");
    const user = userEvent.setup();
    await user.type(input, "abc123");
    await user.click(screen.getByTestId("find-sale-submit"));

    await screen.findByTestId("find-sale-summary");
    await user.click(screen.getByTestId("find-sale-reprint"));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/sales/$id",
      params: { id: "018f9c1a-4b2e-7c00-b000-000000abc123" },
    });
  });

  it("navigates into /sale/$id/void when Void is clicked", async () => {
    await seedEnrolment();
    await seedShift();
    await seedSale("018f9c1a-4b2e-7c00-b000-000000abc123", {
      serverSaleId: "server-sale-1",
    });
    renderScreen();

    const input = await screen.findByTestId("find-sale-input");
    const user = userEvent.setup();
    await user.type(input, "abc123");
    await user.click(screen.getByTestId("find-sale-submit"));

    await screen.findByTestId("find-sale-summary");
    await user.click(screen.getByTestId("find-sale-void"));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/sale/$id/void",
      params: { id: "018f9c1a-4b2e-7c00-b000-000000abc123" },
    });
  });

  // KASA-370 — cross-device fallback. The counter tablet rings a Dexie
  // miss; while online it attempts `GET /v1/sales?receiptCode=…&outletId=…`
  // and, on hit, hydrates the summary card from the server's canonical
  // shape. Offline keeps today's id-ID dead-end so the cashier still
  // reaches for the back-office reconciliation flow.
  describe("KASA-370 cross-device server fallback", () => {
    function remoteSaleBody(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        saleId: "11111111-1111-7000-8000-000000000001",
        name: "SALE-X1",
        localSaleId: "018f9c1a-4b2e-7c00-b000-000000cafe01",
        outletId: "outlet-a",
        clerkId: "kitchen-clerk",
        businessDate: "2026-05-29",
        subtotalIdr: 35_000,
        discountIdr: 0,
        totalIdr: 35_000,
        taxIdr: 0,
        items: [
          {
            itemId: "item-kopi",
            bomId: null,
            quantity: 1,
            uomId: "uom-cup",
            unitPriceIdr: 35_000,
            lineTotalIdr: 35_000,
          },
        ],
        tenders: [{ method: "cash", amountIdr: 35_000, reference: null }],
        createdAt: "2026-05-29T09:05:00.000Z",
        voidedAt: null,
        voidBusinessDate: null,
        voidReason: null,
        localVoidId: null,
        refunds: [],
        ...overrides,
      };
    }

    it("hydrates the summary card from the API when Dexie misses and we are online", async () => {
      await seedEnrolment();
      await seedShift({ businessDate: "2026-05-29" });
      setNavigatorOnLine(true);
      stubFetch(
        async () =>
          new Response(JSON.stringify(remoteSaleBody()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      renderScreen();

      const input = await screen.findByTestId("find-sale-input");
      const user = userEvent.setup();
      // Same-device Dexie has nothing for "cafe01" — the network fallback
      // hits the kitchen tablet's sale at outlet-a.
      await user.type(input, "cafe01");
      await user.click(screen.getByTestId("find-sale-submit"));

      const summary = await screen.findByTestId("find-sale-summary");
      expect(summary).toHaveAttribute("data-local-sale-id", "018f9c1a-4b2e-7c00-b000-000000cafe01");
      expect(screen.getByTestId("find-sale-summary-code")).toHaveTextContent("CAFE01");
      // Reprint + void buttons are enabled because the server-sourced sale
      // landed in Dexie as `status: "synced"` so the downstream screens
      // can read it like a same-device hit.
      expect(screen.getByTestId("find-sale-reprint")).not.toBeDisabled();
      expect(screen.getByTestId("find-sale-void")).not.toBeDisabled();

      // We hit the server with the normalised receiptCode and outlet
      // scope so the route's tenant gate fires.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = String((fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? "");
      expect(calledUrl).toContain("/v1/sales");
      expect(calledUrl).toContain("outletId=outlet-a");
      expect(calledUrl).toContain("receiptCode=CAFE01");
    });

    it("skips the server fallback when the device is offline and still shows the dead-end", async () => {
      await seedEnrolment();
      await seedShift();
      setNavigatorOnLine(false);
      stubFetch(async () => {
        throw new Error("fetch must not be called while offline");
      });
      renderScreen();

      const input = await screen.findByTestId("find-sale-input");
      const user = userEvent.setup();
      await user.type(input, "cafe01");
      await user.click(screen.getByTestId("find-sale-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("find-sale-not-found")).toBeInTheDocument();
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows the dead-end when the server returns 404", async () => {
      await seedEnrolment();
      await seedShift();
      setNavigatorOnLine(true);
      stubFetch(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "sale_not_found", message: "Struk tidak ditemukan." },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
      );
      renderScreen();

      const input = await screen.findByTestId("find-sale-input");
      const user = userEvent.setup();
      await user.type(input, "cafe01");
      await user.click(screen.getByTestId("find-sale-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("find-sale-not-found")).toBeInTheDocument();
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to the dead-end when the network fetch rejects", async () => {
      await seedEnrolment();
      await seedShift();
      setNavigatorOnLine(true);
      stubFetch(async () => {
        throw new TypeError("Failed to fetch");
      });
      renderScreen();

      const input = await screen.findByTestId("find-sale-input");
      const user = userEvent.setup();
      await user.type(input, "cafe01");
      await user.click(screen.getByTestId("find-sale-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("find-sale-not-found")).toBeInTheDocument();
      });
    });

    it("prefers the same-device Dexie row without calling the server", async () => {
      await seedEnrolment();
      await seedShift({ businessDate: "2026-05-29" });
      // Local row already exists for the searched code; the server must
      // not be hit at all.
      await seedSale("018f9c1a-4b2e-7c00-b000-000000abc123", {
        businessDate: "2026-05-29",
        serverSaleId: "server-sale-1",
      });
      setNavigatorOnLine(true);
      stubFetch(async () => {
        throw new Error("server must not be called on a same-device hit");
      });
      renderScreen();

      const input = await screen.findByTestId("find-sale-input");
      const user = userEvent.setup();
      await user.type(input, "abc123");
      await user.click(screen.getByTestId("find-sale-submit"));

      const summary = await screen.findByTestId("find-sale-summary");
      expect(summary).toHaveAttribute("data-local-sale-id", "018f9c1a-4b2e-7c00-b000-000000abc123");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
