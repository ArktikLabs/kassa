import { describe, expect, it } from "vitest";
import { createIntl, createIntlCache } from "react-intl";
import { DEFAULT_LOCALE, messagesFor } from "../i18n/messages.ts";
import { toRupiah } from "../shared/money/index.ts";
import type { Outlet, PendingSale } from "../data/db/types.ts";
import {
  buildWhatsAppReceiptBody,
  buildWhatsAppShareUrl,
} from "../features/receipt/whatsappShare.ts";

/*
 * KASA-252 — unit coverage for the WhatsApp share body builder.
 * Lives in routes/ to satisfy the acceptance-criteria path; the
 * builder itself sits in features/receipt next to the printed
 * receipt code it mirrors.
 */

const locale = DEFAULT_LOCALE;
const intl = createIntl(
  { locale, messages: messagesFor(locale), defaultLocale: "en" },
  createIntlCache(),
);
const formatMessage = (d: { id: string }, v?: Record<string, string | number>): string =>
  intl.formatMessage(d, v);

const baseSale: PendingSale = {
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
  status: "synced",
  attempts: 1,
  lastError: null,
  lastAttemptAt: "2026-04-23T08:30:01.000Z",
  serverSaleName: "S-0001",
};

const outlet: Outlet = {
  id: "22222222-2222-7222-8222-222222222222",
  code: "MAIN",
  name: "Warung Maju",
  timezone: "Asia/Jakarta",
  updatedAt: "2026-04-23T00:00:00.000Z",
};

describe("buildWhatsAppReceiptBody", () => {
  it("renders outlet, totals, tender method and footer in plain text", () => {
    const body = buildWhatsAppReceiptBody({ sale: baseSale, outlet, formatMessage });
    expect(body).toContain("Warung Maju");
    expect(body).toContain("ID 01929b2d");
    // Asia/Jakarta is UTC+7, so 08:30 UTC renders as 15.30
    expect(body).toMatch(/15[.:]30/);
    expect(body).toContain("2x 44444444");
    expect(body).toMatch(/Subtotal[:\s]+Rp\s?50\.000/);
    expect(body).toMatch(/Total[:\s]+Rp\s?50\.000/);
    expect(body).toMatch(/Tunai[:\s]+Rp\s?100\.000/);
    expect(body).toMatch(/Kembalian[:\s]+Rp\s?50\.000/);
    expect(body).toContain("Metode bayar: Tunai");
    expect(body).toContain("Terima kasih");
  });

  it("inserts merchant header lines (KASA-219) when merchant is provided", () => {
    const body = buildWhatsAppReceiptBody({
      sale: baseSale,
      outlet,
      merchant: {
        displayName: "Warung Pusat",
        addressLine: "Jl. Sudirman No.1",
        phone: "+62 21 555 0100",
        npwp: "0123456789012345",
        receiptFooterText: "Sampai jumpa lagi",
      },
      formatMessage,
    });
    const lines = body.split("\n");
    expect(lines[0]).toBe("Warung Pusat");
    expect(lines).toContain("Jl. Sudirman No.1");
    expect(lines).toContain("+62 21 555 0100");
    expect(lines).toContain("NPWP 0123456789012345");
    // outlet name still appears under the merchant block
    expect(lines).toContain("Warung Maju");
    // custom footer wins over the i18n fallback
    expect(body).toContain("Sampai jumpa lagi");
    expect(body).not.toContain("Terima kasih");
  });

  it("breaks out the PPN line when taxIdr is set", () => {
    const taxed: PendingSale = { ...baseSale, taxIdr: toRupiah(4_955) };
    const body = buildWhatsAppReceiptBody({ sale: taxed, outlet, formatMessage });
    expect(body).toMatch(/PPN \(11%\)[:\s]+Rp\s?4\.955/);
  });

  it("omits PPN and discount lines when both are zero or absent", () => {
    const body = buildWhatsAppReceiptBody({ sale: baseSale, outlet, formatMessage });
    expect(body).not.toMatch(/PPN/);
    expect(body).not.toMatch(/Diskon/);
  });

  it("labels split tenders as Campuran", () => {
    const split: PendingSale = {
      ...baseSale,
      tenders: [
        { method: "cash", amountIdr: toRupiah(30_000), reference: null },
        { method: "qris", amountIdr: toRupiah(20_000), reference: "X" },
      ],
    };
    const body = buildWhatsAppReceiptBody({ sale: split, outlet, formatMessage });
    expect(body).toContain("Metode bayar: Campuran");
  });

  it("falls back to the outlet placeholder when outlet is undefined", () => {
    const body = buildWhatsAppReceiptBody({
      sale: baseSale,
      outlet: undefined,
      formatMessage,
    });
    expect(body).toContain("Outlet");
  });
});

describe("buildWhatsAppShareUrl", () => {
  it("wraps the body in the wa.me deep-link with URL encoding that round-trips", () => {
    const body = buildWhatsAppReceiptBody({ sale: baseSale, outlet, formatMessage });
    const url = buildWhatsAppShareUrl(body);
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    const decoded = decodeURIComponent(url.slice("https://wa.me/?text=".length));
    expect(decoded).toBe(body);
  });

  it("encodes newlines and rupiah punctuation without double-encoding", () => {
    const url = buildWhatsAppShareUrl("Total: Rp 50.000\nKembalian: Rp 0");
    // Newline should be %0A exactly once; never %250A.
    expect(url).toContain("%0A");
    expect(url).not.toContain("%25");
  });
});
