import { describe, expect, it } from "vitest";
import type { PendingSale, Outlet } from "../../data/db/types.ts";
import { toRupiah } from "../../shared/money/index.ts";
import {
  buildPdfReceiptInput,
  encodePdfReceipt,
  pdfReceiptFilename,
  type PdfReceiptInput,
} from "./pdf.ts";

const I18N: Parameters<typeof buildPdfReceiptInput>[0]["i18n"] = {
  outletUnknown: "Outlet",
  npwpLabel: "NPWP",
  subtotalLabel: "Subtotal",
  discountLabel: "Diskon",
  taxLabelTemplate: (rate) => `PPN (${rate}%)`,
  totalLabel: "Total",
  tenderedLabel: "Tunai",
  changeLabel: "Kembalian",
  footerThanks: "Terima kasih",
  salinanBanner: "SALINAN",
  pembatalanBanner: "PEMBATALAN",
  pembatalanReference: "Transaksi ini dibatalkan dengan struk asli sebagai referensi.",
  pembatalanQrisRefund: "Refund manual ke pelanggan",
};

const OUTLET: Outlet = {
  id: "22222222-2222-7222-8222-222222222222",
  code: "MAIN",
  name: "Warung Maju",
  timezone: "Asia/Jakarta",
  displayName: null,
  addressLine1: null,
  addressLine2: null,
  taxId: null,
  receiptFooterLine1: null,
  receiptFooterLine2: null,
  updatedAt: "2026-04-23T00:00:00.000Z",
};

function makeSale(overrides: Partial<PendingSale> = {}): PendingSale {
  const base: PendingSale = {
    localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
    outletId: OUTLET.id,
    clerkId: "77777777-7777-7777-8777-777777777777",
    businessDate: "2026-04-23",
    createdAt: "2026-04-23T08:30:00.000Z",
    subtotalIdr: toRupiah(25_000),
    discountIdr: toRupiah(0),
    totalIdr: toRupiah(27_750),
    taxIdr: toRupiah(2_750),
    items: [
      {
        itemId: "44444444-4444-7444-8444-444444444444",
        bomId: null,
        quantity: 1,
        uomId: "55555555-5555-7555-8555-555555555555",
        unitPriceIdr: toRupiah(25_000),
        lineTotalIdr: toRupiah(25_000),
      },
    ],
    tenders: [
      {
        method: "cash",
        amountIdr: toRupiah(30_000),
        reference: null,
      },
    ],
    status: "queued",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    serverSaleName: null,
    serverSaleId: null,
    voidedAt: null,
  };
  return { ...base, ...overrides };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

describe("encodePdfReceipt", () => {
  const baseInput: PdfReceiptInput = {
    paperWidth: "58mm",
    voided: false,
    outletName: "Warung Maju",
    outletTimezone: "Asia/Jakarta",
    merchant: null,
    npwpLabel: "NPWP",
    createdAtIso: "2026-04-23T08:30:00.000Z",
    localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
    itemLines: [{ left: "1x Kopi Sus", right: "Rp 25.000" }],
    subtotalLabel: "Subtotal",
    subtotal: "Rp 25.000",
    totalLabel: "Total",
    total: "Rp 25.000",
    tenderedLabel: "Tunai",
    tendered: "Rp 30.000",
    changeLabel: "Kembalian",
    change: "Rp 5.000",
    footerText: "Terima kasih",
  };

  it("emits a valid PDF 1.4 file with xref + EOF marker", () => {
    const bytes = encodePdfReceipt(baseInput);
    const text = decode(bytes);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("xref\n0 7\n");
    expect(text).toContain("trailer\n");
    expect(text.trim().endsWith("%%EOF")).toBe(true);
  });

  it("includes the outlet name and totals so a viewer renders the same content as the printout", () => {
    const text = decode(encodePdfReceipt(baseInput));
    expect(text).toContain("(Warung Maju)");
    expect(text).toContain("(Total");
    expect(text).toContain("Rp 25.000)");
  });

  it("transliterates the em-dash in the footer so Courier WinAnsi renders cleanly", () => {
    const text = decode(
      encodePdfReceipt({ ...baseInput, footerText: "Terima kasih — sampai jumpa lagi" }),
    );
    expect(text).toContain("(Terima kasih - sampai jumpa lagi)");
    expect(text).not.toMatch(/—/);
  });

  it("emits PEMBATALAN banner + QRIS refund line when the sale is a voided QRIS payment", () => {
    const text = decode(
      encodePdfReceipt({
        ...baseInput,
        voided: true,
        voidedBannerText: "PEMBATALAN",
        voidedReferenceText: "Transaksi ini dibatalkan dengan struk asli sebagai referensi.",
        voidedQrisRefundNotice: "Refund manual ke pelanggan",
      }),
    );
    expect(text).toContain("(*** PEMBATALAN ***)");
    expect(text).toContain("(Refund manual ke pelanggan)");
  });

  it("emits SALINAN banner when reprinting", () => {
    const text = decode(
      encodePdfReceipt({ ...baseInput, salinan: true, salinanBannerText: "SALINAN" }),
    );
    expect(text).toContain("(*** SALINAN ***)");
  });

  it("widens the MediaBox for 80mm paper", () => {
    const text58 = decode(encodePdfReceipt({ ...baseInput, paperWidth: "58mm" }));
    const text80 = decode(encodePdfReceipt({ ...baseInput, paperWidth: "80mm" }));
    expect(text58).toMatch(/MediaBox \[0 0 165 \d+\]/);
    expect(text80).toMatch(/MediaBox \[0 0 227 \d+\]/);
  });
});

describe("buildPdfReceiptInput", () => {
  it("derives the discount/tax rows the same way usePrintReceipt does", () => {
    const sale = makeSale({ discountIdr: toRupiah(1_000), taxIdr: toRupiah(2_750) });
    const input = buildPdfReceiptInput({
      sale,
      outlet: OUTLET,
      paperWidth: "58mm",
      i18n: I18N,
    });
    expect(input.discountLabel).toBe("Diskon");
    expect(input.discount).toBeDefined();
    expect(input.taxLabel).toBe("PPN (11%)");
  });

  it("omits the discount row when the sale has zero discount", () => {
    const input = buildPdfReceiptInput({
      sale: makeSale({ discountIdr: toRupiah(0) }),
      outlet: OUTLET,
      paperWidth: "58mm",
      i18n: I18N,
    });
    expect(input.discountLabel).toBeUndefined();
  });

  it("falls back to the outlet-unknown label when no outlet is provided", () => {
    const input = buildPdfReceiptInput({
      sale: makeSale(),
      outlet: undefined,
      paperWidth: "58mm",
      i18n: I18N,
    });
    expect(input.outletName).toBe("Outlet");
  });

  // KASA-367 — per-outlet receipt branding overrides.
  describe("KASA-367 per-outlet branding", () => {
    const brandedOutlet: Outlet = {
      ...OUTLET,
      displayName: "Warung Pusat",
      addressLine1: "Jl. Sudirman No.1",
      addressLine2: null,
      taxId: "012345678901000",
      receiptFooterLine1: "Terima kasih atas kunjungan Anda",
      receiptFooterLine2: null,
    };

    it("derives outletBranding from the outlet row's KASA-367 fields", () => {
      const input = buildPdfReceiptInput({
        sale: makeSale(),
        outlet: brandedOutlet,
        paperWidth: "58mm",
        i18n: I18N,
      });
      expect(input.outletBranding).toEqual({
        displayName: "Warung Pusat",
        addressLine1: "Jl. Sudirman No.1",
        addressLine2: null,
        taxId: "012345678901000",
        footerLine1: "Terima kasih atas kunjungan Anda",
        footerLine2: null,
      });
    });

    it("renders the branded header + NPWP mask + custom footer into the PDF bytes", () => {
      const input = buildPdfReceiptInput({
        sale: makeSale(),
        outlet: brandedOutlet,
        paperWidth: "58mm",
        i18n: I18N,
      });
      const bytes = encodePdfReceipt(input);
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text).toContain("Warung Pusat");
      expect(text).toContain("Jl. Sudirman No.1");
      expect(text).toContain("NPWP 01.234.567.8-901.000");
      expect(text).toContain("Terima kasih atas kunjungan Anda");
    });

    it("falls back to the bare outlet name when no branding overrides are set", () => {
      const input = buildPdfReceiptInput({
        sale: makeSale(),
        outlet: OUTLET,
        paperWidth: "58mm",
        i18n: I18N,
      });
      const bytes = encodePdfReceipt(input);
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text).toContain("Warung Maju");
      expect(text).not.toContain("NPWP");
    });
  });
});

describe("pdfReceiptFilename", () => {
  it("uses the server sale name when present", () => {
    const sale = makeSale({ serverSaleName: "POS-SALE-0042" });
    expect(pdfReceiptFilename(sale)).toBe("kassa-22222222-POS-SALE-0042.pdf");
  });

  it("falls back to the local sale id prefix when the server hasn't named the sale yet", () => {
    const sale = makeSale();
    expect(pdfReceiptFilename(sale)).toMatch(/^kassa-22222222-[0-9a-f]{8}\.pdf$/);
  });

  it("sanitises filename-unsafe characters out of the server name", () => {
    const sale = makeSale({ serverSaleName: "POS/SALE 0001" });
    expect(pdfReceiptFilename(sale)).toBe("kassa-22222222-POS-SALE-0001.pdf");
  });
});
