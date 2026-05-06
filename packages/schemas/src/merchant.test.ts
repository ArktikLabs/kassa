import { describe, expect, it } from "vitest";
import { merchantMeResponse, merchantSettings, merchantSettingsUpdateRequest } from "./merchant.js";

describe("merchantSettings", () => {
  it("accepts a fully-populated settings object", () => {
    const parsed = merchantSettings.parse({
      displayName: "Warung Pusat",
      addressLine: "Jl. Sudirman No.1, Jakarta",
      phone: "+62 21 555 0100",
      npwp: "0123456789012345",
      receiptFooterText: "Terima kasih atas kunjungan Anda",
    });
    expect(parsed.displayName).toBe("Warung Pusat");
    expect(parsed.npwp).toBe("0123456789012345");
  });

  it("trims displayName whitespace and rejects an empty result", () => {
    expect(
      merchantSettings.parse({
        displayName: "  Warung  ",
        addressLine: null,
        phone: null,
        npwp: null,
        receiptFooterText: null,
      }).displayName,
    ).toBe("Warung");
    expect(() =>
      merchantSettings.parse({
        displayName: "   ",
        addressLine: null,
        phone: null,
        npwp: null,
        receiptFooterText: null,
      }),
    ).toThrow();
  });

  it("rejects a 15-digit (legacy) NPWP", () => {
    expect(() =>
      merchantSettings.parse({
        displayName: "Warung",
        addressLine: null,
        phone: null,
        npwp: "012345678901234",
        receiptFooterText: null,
      }),
    ).toThrow(/NPWP/);
  });

  it("rejects letters in phone", () => {
    expect(() =>
      merchantSettings.parse({
        displayName: "Warung",
        addressLine: null,
        phone: "call us",
        npwp: null,
        receiptFooterText: null,
      }),
    ).toThrow();
  });

  it("rejects displayName over 80 chars", () => {
    expect(() =>
      merchantSettings.parse({
        displayName: "x".repeat(81),
        addressLine: null,
        phone: null,
        npwp: null,
        receiptFooterText: null,
      }),
    ).toThrow();
  });
});

describe("merchantSettingsUpdateRequest", () => {
  it("accepts a partial patch (footer only)", () => {
    const parsed = merchantSettingsUpdateRequest.parse({
      receiptFooterText: "Sampai jumpa lagi",
    });
    expect(parsed).toEqual({ receiptFooterText: "Sampai jumpa lagi" });
  });

  it("accepts null to clear an optional field", () => {
    const parsed = merchantSettingsUpdateRequest.parse({ npwp: null });
    expect(parsed.npwp).toBeNull();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      merchantSettingsUpdateRequest.parse({ logoUrl: "https://example.com/logo.png" }),
    ).toThrow();
  });

  it("rejects an empty displayName when patching", () => {
    expect(() => merchantSettingsUpdateRequest.parse({ displayName: "  " })).toThrow();
  });
});

describe("merchantMeResponse", () => {
  it("validates a server response shape", () => {
    const parsed = merchantMeResponse.parse({
      id: "018f9c1a-4b2e-7c00-b000-000000000001",
      settings: {
        displayName: "Warung Pusat",
        addressLine: null,
        phone: null,
        npwp: null,
        receiptFooterText: null,
      },
      updatedAt: "2026-05-06T10:30:00.000+07:00",
    });
    expect(parsed.id).toBe("018f9c1a-4b2e-7c00-b000-000000000001");
  });
});
