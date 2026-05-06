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
});
