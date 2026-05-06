import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE, messagesFor } from "../../i18n/messages.ts";
import { toRupiah } from "../../shared/money/index.ts";
import type { Outlet, PendingSale } from "../../data/db/types.ts";
import { ReceiptPreview } from "./ReceiptPreview.tsx";

const locale = DEFAULT_LOCALE;
const messages = messagesFor(locale);

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      {ui}
    </IntlProvider>,
  );
}

const sale: PendingSale = {
  localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
  outletId: "22222222-2222-7222-8222-222222222222",
  clerkId: "11111111-1111-7111-8111-111111111111",
  businessDate: "2026-04-23",
  createdAt: "2026-04-23T08:30:00.000Z",
  subtotalIdr: toRupiah(50_000),
  discountIdr: toRupiah(0),
  totalIdr: toRupiah(50_000),
  items: [
    {
      itemId: "44444444-4444-7444-8444-444444444444",
      bomId: null,
      quantity: 2,
      uomId: "55555555-5555-7555-8555-555555555555",
      unitPriceIdr: toRupiah(25_000),
      lineTotalIdr: toRupiah(50_000),
    },
  ],
  tenders: [{ method: "cash", amountIdr: toRupiah(100_000), reference: null }],
  status: "queued",
  attempts: 0,
  lastError: null,
  lastAttemptAt: null,
  serverSaleName: null,
};

const outlet: Outlet = {
  id: "22222222-2222-7222-8222-222222222222",
  code: "MAIN",
  name: "Warung Maju",
  timezone: "Asia/Jakarta",
  updatedAt: "2026-04-23T00:00:00.000Z",
};

describe("ReceiptPreview", () => {
  it("renders the outlet name, totals, and computed change for the 58mm layout", () => {
    renderWithIntl(<ReceiptPreview sale={sale} outlet={outlet} paperWidth="58mm" />);
    const preview = screen.getByTestId("receipt-preview");
    expect(preview).toHaveAttribute("data-paper-width", "58mm");
    expect(preview).toHaveStyle({ width: "280px" });
    expect(screen.getByTestId("receipt-outlet-name")).toHaveTextContent("Warung Maju");
    expect(preview.textContent).toMatch(/Total/);
    expect(preview.textContent).toMatch(/50\.000/);
    expect(preview.textContent).toMatch(/Kembalian/);
    expect(preview.textContent).toMatch(/50\.000/); // change == 100k - 50k
  });

  it("switches to the 380px width for 80mm paper", () => {
    renderWithIntl(<ReceiptPreview sale={sale} outlet={outlet} paperWidth="80mm" />);
    const preview = screen.getByTestId("receipt-preview");
    expect(preview).toHaveAttribute("data-paper-width", "80mm");
    expect(preview).toHaveStyle({ width: "380px" });
  });

  it("renders a PPN line above Total when the sale carries taxIdr (KASA-218)", () => {
    const taxedSale: PendingSale = { ...sale, taxIdr: toRupiah(4_955) };
    renderWithIntl(<ReceiptPreview sale={taxedSale} outlet={outlet} paperWidth="58mm" />);
    const tax = screen.getByTestId("receipt-tax");
    expect(tax.textContent).toMatch(/PPN \(11%\)/);
    expect(tax.textContent).toMatch(/4\.955/);
  });

  it("hides the PPN row entirely when taxIdr is absent or zero", () => {
    renderWithIntl(<ReceiptPreview sale={sale} outlet={outlet} paperWidth="58mm" />);
    expect(screen.queryByTestId("receipt-tax")).toBeNull();
    const zeroTaxSale: PendingSale = { ...sale, taxIdr: toRupiah(0) };
    renderWithIntl(<ReceiptPreview sale={zeroTaxSale} outlet={outlet} paperWidth="58mm" />);
    expect(screen.queryByTestId("receipt-tax")).toBeNull();
  });

  it("does not render the SALINAN banner on a fresh post-sale print", () => {
    renderWithIntl(<ReceiptPreview sale={sale} outlet={outlet} paperWidth="58mm" />);
    expect(screen.queryByTestId("receipt-salinan-banner")).toBeNull();
  });

  it("renders a SALINAN banner above the outlet when reprinted", () => {
    renderWithIntl(<ReceiptPreview sale={sale} outlet={outlet} paperWidth="58mm" salinan />);
    const banner = screen.getByTestId("receipt-salinan-banner");
    const outletNameNode = screen.getByTestId("receipt-outlet-name");
    expect(banner).toHaveTextContent(/SALINAN/);
    expect(banner.compareDocumentPosition(outletNameNode)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
