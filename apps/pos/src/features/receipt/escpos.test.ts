import { describe, expect, it } from "vitest";
import { EscPosBuilder, centerLineForWidth, encodeReceipt, padBetweenForWidth } from "./escpos.ts";

describe("EscPosBuilder", () => {
  it("emits ESC @ at the start when init() is called", () => {
    const bytes = new EscPosBuilder().init().build();
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
  });

  it("transliterates non-ASCII characters to '?' so the printer code page is safe", () => {
    const bytes = new EscPosBuilder().text("ê").build();
    expect(Array.from(bytes)).toEqual([0x3f]); // "?"
  });

  it("cut() emits GS V 1 for a partial cut", () => {
    const bytes = new EscPosBuilder().cut(true).build();
    expect(Array.from(bytes)).toEqual([0x1d, 0x56, 0x01]);
  });
});

describe("padBetweenForWidth", () => {
  it("right-aligns the amount inside the given column width", () => {
    expect(padBetweenForWidth("Total", "Rp 50.000", 32)).toBe("Total                  Rp 50.000");
  });

  it("elides the left side with an ellipsis when it would overflow", () => {
    const result = padBetweenForWidth("An extremely long product name here", "Rp 1", 32);
    expect(result.endsWith("Rp 1")).toBe(true);
    expect(result).toHaveLength(32);
    expect(result).toContain("…");
  });
});

describe("centerLineForWidth", () => {
  it("centers short text within the paper width", () => {
    expect(centerLineForWidth("Kassa", 32)).toBe("             Kassa");
  });
});

describe("encodeReceipt", () => {
  const basePayload = {
    outletName: "Warung Maju",
    outletTimezone: "Asia/Jakarta",
    address: null,
    createdAtIso: "2026-04-23T08:30:00.000Z",
    localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
    items: [{ left: "1x Kopi", right: "Rp 25.000" }],
    subtotal: "Rp 25.000",
    discount: "Rp 25.000",
    total: "Rp 25.000",
    tenderedLabel: "Tunai",
    tendered: "Rp 50.000",
    changeLabel: "Kembalian",
    change: "Rp 25.000",
    footerThanks: "Terima kasih",
    width: 32 as const,
  };

  function decodeAscii(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i] ?? 0;
      out += b < 0x20 ? "·" : String.fromCharCode(b);
    }
    return out;
  }

  it("produces a non-empty byte array that starts with ESC @ and ends with GS V", () => {
    const bytes = encodeReceipt(basePayload);
    expect(bytes.length).toBeGreaterThan(32);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-3))).toEqual([0x1d, 0x56, 0x01]);
  });

  it("renders a PPN line between Diskon and Total when taxLabel/tax are set (KASA-218)", () => {
    const bytes = encodeReceipt({
      outletName: "Warung Maju",
      outletTimezone: "Asia/Jakarta",
      address: null,
      createdAtIso: "2026-04-23T08:30:00.000Z",
      localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
      items: [{ left: "1x Kopi", right: "Rp 11.000" }],
      subtotal: "Rp 11.000",
      discount: "Rp 0",
      taxLabel: "PPN (11%)",
      tax: "Rp 1.090",
      total: "Rp 11.000",
      tenderedLabel: "Tunai",
      tendered: "Rp 11.000",
      changeLabel: "Kembalian",
      change: "Rp 0",
      footerThanks: "Terima kasih",
      width: 32,
    });
    const text = decodeAscii(bytes);
    const ppnIdx = text.indexOf("PPN (11%)");
    const totalIdx = text.indexOf("Total");
    expect(ppnIdx).toBeGreaterThan(-1);
    expect(totalIdx).toBeGreaterThan(ppnIdx);
    expect(text).toContain("Rp 1.090");
  });

  it("omits the PPN row when no taxLabel/tax provided", () => {
    const bytes = encodeReceipt({
      outletName: "Warung Maju",
      outletTimezone: "Asia/Jakarta",
      address: null,
      createdAtIso: "2026-04-23T08:30:00.000Z",
      localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
      items: [{ left: "1x Kopi", right: "Rp 25.000" }],
      subtotal: "Rp 25.000",
      discount: "Rp 0",
      total: "Rp 25.000",
      tenderedLabel: "Tunai",
      tendered: "Rp 25.000",
      changeLabel: "Kembalian",
      change: "Rp 0",
      footerThanks: "Terima kasih",
      width: 32,
    });
    const text = decodeAscii(bytes);
    expect(text).not.toContain("PPN");
  });

  it("does not include the SALINAN banner by default (post-sale first print)", () => {
    const bytes = encodeReceipt(basePayload);
    expect(decodeAscii(bytes)).not.toContain("SALINAN");
  });

  it("emits a SALINAN banner above the outlet name when salinan is true", () => {
    const bytes = encodeReceipt({ ...basePayload, salinan: true });
    const text = decodeAscii(bytes);
    const salinanAt = text.indexOf("SALINAN");
    const outletAt = text.indexOf("Warung Maju");
    expect(salinanAt).toBeGreaterThanOrEqual(0);
    expect(outletAt).toBeGreaterThan(salinanAt);
  });

  it("renders the merchant header (name, address, phone, NPWP) and custom footer when provided", () => {
    const bytes = encodeReceipt({
      outletName: "Warung Maju",
      outletTimezone: "Asia/Jakarta",
      merchant: {
        displayName: "Warung Pusat",
        addressLine: "Jl. Sudirman No.1",
        phone: "+62 21 555 0100",
        npwp: "0123456789012345",
        npwpLabel: "NPWP",
        receiptFooterText: "Sampai jumpa lagi",
      },
      createdAtIso: "2026-04-23T08:30:00.000Z",
      localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
      items: [{ left: "1x Kopi", right: "Rp 25.000" }],
      subtotal: "Rp 25.000",
      discount: "Rp 25.000",
      total: "Rp 25.000",
      tenderedLabel: "Tunai",
      tendered: "Rp 50.000",
      changeLabel: "Kembalian",
      change: "Rp 25.000",
      footerThanks: "Terima kasih",
      width: 32,
    });
    const text = new TextDecoder("ascii").decode(bytes);
    expect(text).toContain("Warung Pusat");
    expect(text).toContain("Jl. Sudirman No.1");
    expect(text).toContain("+62 21 555 0100");
    expect(text).toContain("NPWP 0123456789012345");
    // Outlet name still printed below the merchant block.
    expect(text).toContain("Warung Maju");
    expect(text).toContain("Sampai jumpa lagi");
    // Default footer is not used when merchant supplies one.
    expect(text).not.toContain("Terima kasih");
  });

  it("omits optional merchant fields when null and falls back to the default footer", () => {
    const bytes = encodeReceipt({
      outletName: "Warung Maju",
      outletTimezone: "Asia/Jakarta",
      merchant: {
        displayName: "Warung Pusat",
        addressLine: null,
        phone: null,
        npwp: null,
        npwpLabel: "NPWP",
        receiptFooterText: null,
      },
      createdAtIso: "2026-04-23T08:30:00.000Z",
      localSaleId: "01929b2d-1e01-7f00-80aa-000000000001",
      items: [{ left: "1x Kopi", right: "Rp 25.000" }],
      subtotal: "Rp 25.000",
      discount: "Rp 25.000",
      total: "Rp 25.000",
      tenderedLabel: "Tunai",
      tendered: "Rp 50.000",
      changeLabel: "Kembalian",
      change: "Rp 25.000",
      footerThanks: "Terima kasih",
      width: 32,
    });
    const text = new TextDecoder("ascii").decode(bytes);
    expect(text).toContain("Warung Pusat");
    expect(text).not.toContain("NPWP");
    expect(text).toContain("Terima kasih");
  });
});
