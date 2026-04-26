import { describe, expect, it } from "vitest";
import { _scrubStringForTest as scrub } from "./sentry.ts";

describe("sentry scrubString", () => {
  describe("phone numbers (ADR-010)", () => {
    it.each([
      ["+62 812 3456 7890", "[phone]"],
      ["+62-812-3456-7890", "[phone]"],
      ["+628123456789", "[phone]"],
      ["0812-3456-7890", "[phone]"],
      ["08123456789", "[phone]"],
      ["62 800 1234 5678", "[phone]"],
    ])("masks Indonesian phone %s", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it("masks a phone embedded in a sentence", () => {
      expect(scrub("Call 0812-3456-7890 now")).toBe("Call [phone] now");
    });

    it("does not mask dotted version-like numerics", () => {
      // Regression: pre-tightening, '0.500.100.123' was masked as [phone].
      expect(scrub("Build 0.500.100.123 failed")).toBe("Build 0.500.100.123 failed");
    });

    it("does not mask plain decimals or short digit groups", () => {
      expect(scrub("Total 1.50 IDR")).toBe("Total 1.50 IDR");
      expect(scrub("v1.0.2 released")).toBe("v1.0.2 released");
      expect(scrub("hash 0.123.456.789")).toBe("hash 0.123.456.789");
    });

    it("does not mask numbers without the +62/62/0 prefix", () => {
      // Conservative: spec requires a recognisable Indonesian prefix.
      expect(scrub("token 9123456789")).toBe("token 9123456789");
    });
  });

  describe("addresses", () => {
    it.each([
      "Jl. Sudirman No. 25",
      "Jalan Merdeka No. 10",
      "Gg. Mawar No. 7",
      "jl. kebon jeruk no. 5",
    ])("masks full Indonesian street address: %s", (input) => {
      expect(scrub(input)).toBe("[address]");
    });

    it("masks a multi-component address as a single span", () => {
      // STREET regex consumes the street + first numbered component;
      // remaining RT/RW numbers are caught by the number regex.
      expect(scrub("Jl. Kebon Jeruk No. 5 RT 03 RW 04")).toBe("[address] [address] [address]");
    });

    it.each([
      ["No. 25", "[address]"],
      ["RT 03", "[address]"],
      ["RW 04", "[address]"],
    ])("masks bare numbered component %s", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it("does not mask 'no one' as an address", () => {
      // Regression: pre-tightening, 'no one' was masked as [address].
      expect(scrub("There is no one here")).toBe("There is no one here");
    });

    it("does not mask other generic English starting with the prefix tokens", () => {
      expect(scrub("rt happy path")).toBe("rt happy path");
      expect(scrub("no problem at all")).toBe("no problem at all");
      // 'Jl.' alone (street prefix without a numbered component) is left
      // alone — a bare street name is below ADR-010's PII threshold.
      expect(scrub("Jl. Sudirman is a major road")).toBe("Jl. Sudirman is a major road");
    });
  });

  describe("emails", () => {
    it("masks emails", () => {
      expect(scrub("contact admin@example.com today")).toBe("contact [email] today");
    });
  });

  describe("long digit runs", () => {
    it("masks 12+ digit runs (card / bank-account shaped)", () => {
      expect(scrub("acct 4111111111111111 was charged")).toBe("acct [digits] was charged");
    });

    it("does not mask shorter digit runs", () => {
      expect(scrub("order 12345 fulfilled")).toBe("order 12345 fulfilled");
    });
  });

  describe("composite", () => {
    it("scrubs phone + email + address in one pass", () => {
      const input = "Order from admin@example.com at Jl. Sudirman No. 25, phone 0812-3456-7890";
      expect(scrub(input)).toBe("Order from [email] at [address], phone [phone]");
    });
  });
});
