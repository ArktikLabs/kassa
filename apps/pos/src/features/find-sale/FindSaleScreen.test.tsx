import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE, messagesFor } from "../../i18n/messages.ts";
import { _resetDatabaseSingletonForTest, getDatabase } from "../../data/db/index.ts";
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
  beforeEach(() => {
    resetEnrolmentForTest();
    navigateMock.mockReset();
  });

  afterEach(async () => {
    await _resetDatabaseSingletonForTest();
    resetEnrolmentForTest();
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
});
