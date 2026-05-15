import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE, messagesFor } from "../../i18n/messages.ts";
import { _resetDatabaseSingletonForTest, getDatabase } from "../../data/db/index.ts";
import { _resetForTest as resetEnrolmentForTest } from "../../lib/enrolment.ts";
import { toRupiah } from "../../shared/money/index.ts";
import { SaleHistoryScreen } from "./SaleHistoryScreen.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    className,
    ...rest
  }: React.PropsWithChildren<{
    to: string;
    params?: Record<string, string>;
    className?: string;
    [key: string]: unknown;
  }>) => {
    const href =
      params && Object.keys(params).length
        ? Object.entries(params).reduce((acc, [key, value]) => acc.replace(`$${key}`, value), to)
        : to;
    return (
      <a href={href} className={className} {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    );
  },
}));

const locale = DEFAULT_LOCALE;
const messages = messagesFor(locale);

function renderScreen() {
  return render(
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      <SaleHistoryScreen />
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
    enrolledAt: "2026-04-23T00:00:00.000Z",
  });
}

async function seedSale(localSaleId: string, createdAt: string, total = 25_000) {
  const { repos } = await getDatabase();
  await repos.pendingSales.enqueue({
    localSaleId,
    outletId: "outlet-a",
    clerkId: "clerk-1",
    businessDate: "2026-04-23",
    createdAt,
    subtotalIdr: toRupiah(total),
    discountIdr: toRupiah(0),
    totalIdr: toRupiah(total),
    items: [
      {
        itemId: "item-1",
        bomId: null,
        quantity: 1,
        uomId: "uom-cup",
        unitPriceIdr: toRupiah(total),
        lineTotalIdr: toRupiah(total),
      },
    ],
    tenders: [{ method: "cash", amountIdr: toRupiah(total), reference: null }],
  });
}

describe("SaleHistoryScreen", () => {
  beforeEach(() => {
    resetEnrolmentForTest();
  });

  afterEach(async () => {
    await _resetDatabaseSingletonForTest();
    resetEnrolmentForTest();
  });

  it("warns when the device is not enrolled (no outlet to scope the history)", async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId("sales-history-unenrolled")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("sales-history-list")).toBeNull();
  });

  it("renders the empty-state when the outbox has no sales for this outlet", async () => {
    await seedEnrolment();
    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId("sales-history-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("sales-history-list")).toBeNull();
  });

  it("renders rows newest-first with a deep-link to /sales/$id", async () => {
    await seedEnrolment();
    await seedSale("sale-old", "2026-04-23T08:00:00.000Z", 10_000);
    await seedSale("sale-mid", "2026-04-23T09:00:00.000Z", 20_000);
    await seedSale("sale-new", "2026-04-23T10:00:00.000Z", 30_000);

    renderScreen();
    const list = await screen.findByTestId("sales-history-list");
    const rows = within(list).getAllByTestId("sales-history-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("data-local-sale-id", "sale-new");
    expect(rows[2]).toHaveAttribute("data-local-sale-id", "sale-old");
    // The reprint deep-link is the first <a> inside each row card
    // (KASA-236-B nested the Batalkan affordance alongside it).
    const reprintLink = rows[0]!.querySelector("a");
    expect(reprintLink).toHaveAttribute("href", "/sales/sale-new");
  });
});
