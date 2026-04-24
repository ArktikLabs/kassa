import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeMidtransSignature,
  createMidtransProvider,
} from "../src/providers/midtrans.js";
import { WebhookSignatureError } from "../src/types.js";

const SERVER_KEY = "SB-Mid-server-test-signature-1234567890";

function buildPayload(overrides: Partial<Record<string, string>> = {}) {
  const base: Record<string, string> = {
    order_id: "ORDER-ABC-123",
    status_code: "200",
    gross_amount: "15000.00",
    transaction_status: "settlement",
    fraud_status: "accept",
    transaction_time: "2026-04-22 20:30:00",
    transaction_id: "tx-xyz",
    payment_type: "qris",
  };
  const merged = { ...base, ...overrides };
  const signature = createHash("sha512")
    .update(`${merged.order_id}${merged.status_code}${merged.gross_amount}${SERVER_KEY}`)
    .digest("hex");
  return { ...merged, signature_key: signature };
}

describe("computeMidtransSignature", () => {
  it("produces the documented SHA-512 hex digest", () => {
    const sig = computeMidtransSignature("A", "200", "10.00", "k");
    const expected = createHash("sha512").update("A20010.00k").digest("hex");
    expect(sig).toBe(expected);
    expect(sig).toHaveLength(128);
  });
});

describe("createMidtransProvider.verifyWebhookSignature", () => {
  const provider = createMidtransProvider({
    serverKey: SERVER_KEY,
    environment: "sandbox",
    now: () => new Date("2026-04-22T20:30:00.000Z"),
  });

  it("accepts a well-formed payload with the correct signature_key", () => {
    const payload = buildPayload();
    const event = provider.verifyWebhookSignature(payload, {});
    expect(event.signatureVerified).toBe(true);
    expect(event.providerOrderId).toBe("ORDER-ABC-123");
    expect(event.status).toBe("paid");
    expect(event.grossAmount).toBe(15000);
    expect(event.occurredAt).toBe("2026-04-22T20:30:00+07:00");
  });

  it("rejects a payload with a tampered signature", () => {
    const payload = buildPayload();
    const tampered = { ...payload, signature_key: "0".repeat(128) };
    expect(() => provider.verifyWebhookSignature(tampered, {})).toThrow(
      WebhookSignatureError,
    );
  });

  it("rejects a payload with a mutated gross_amount (recomputes mismatch)", () => {
    const payload = buildPayload();
    const mutated = { ...payload, gross_amount: "1.00" };
    expect(() => provider.verifyWebhookSignature(mutated, {})).toThrow(
      WebhookSignatureError,
    );
  });

  it("rejects non-object payloads", () => {
    expect(() => provider.verifyWebhookSignature("not an object", {})).toThrow(
      WebhookSignatureError,
    );
    expect(() => provider.verifyWebhookSignature(null, {})).toThrow(
      WebhookSignatureError,
    );
  });

  it("rejects payloads missing required fields", () => {
    const incomplete = { order_id: "A", status_code: "200" };
    expect(() => provider.verifyWebhookSignature(incomplete, {})).toThrow(
      WebhookSignatureError,
    );
  });

  it("maps transaction_status=pending to status pending", () => {
    const payload = buildPayload({ transaction_status: "pending" });
    const event = provider.verifyWebhookSignature(payload, {});
    expect(event.status).toBe("pending");
  });

  it("maps transaction_status=expire to status expired", () => {
    const payload = buildPayload({ transaction_status: "expire" });
    const event = provider.verifyWebhookSignature(payload, {});
    expect(event.status).toBe("expired");
  });

  it("treats fraud_status=challenge on capture as pending (not paid)", () => {
    const payload = buildPayload({
      transaction_status: "capture",
      fraud_status: "challenge",
    });
    const event = provider.verifyWebhookSignature(payload, {});
    expect(event.status).toBe("pending");
  });

  it("treats fraud_status=deny on settlement as failed (not paid)", () => {
    const payload = buildPayload({
      transaction_status: "settlement",
      fraud_status: "deny",
    });
    const event = provider.verifyWebhookSignature(payload, {});
    expect(event.status).toBe("failed");
  });
});

// KASA-93: NormalizedWebhookEvent.occurredAt must be ISO-8601 with an explicit
// offset on both branches so consumers can call `new Date(occurredAt)` without
// hitting implementation-defined behavior on the Midtrans-local-time path.
describe("createMidtransProvider.verifyWebhookSignature occurredAt contract", () => {
  it("converts Midtrans transaction_time (Asia/Jakarta) to ISO-8601 with +07:00 offset", () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      now: () => new Date("2026-04-22T20:30:00.000Z"),
    });
    const payload = buildPayload({ transaction_time: "2026-04-22 20:30:00" });
    const event = provider.verifyWebhookSignature(payload, {});

    expect(event.occurredAt).toBe("2026-04-22T20:30:00+07:00");
    const parsed = Date.parse(event.occurredAt);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(
      Math.abs(parsed - Date.UTC(2026, 3, 22, 13, 30, 0)),
    ).toBeLessThanOrEqual(1000);
  });

  it("falls back to now().toISOString() (UTC, Z suffix) when transaction_time is absent", () => {
    const fixedNow = new Date("2026-04-22T13:30:05.000Z");
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      now: () => fixedNow,
    });
    const withoutTime: Record<string, string> = { ...buildPayload() };
    delete withoutTime.transaction_time;
    const event = provider.verifyWebhookSignature(withoutTime, {});

    expect(event.occurredAt).toBe("2026-04-22T13:30:05.000Z");
    const parsed = Date.parse(event.occurredAt);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(Math.abs(parsed - fixedNow.getTime())).toBeLessThanOrEqual(1000);
  });

  it("falls back to now() when transaction_time is malformed", () => {
    // If Midtrans ever ships a malformed value, leaking it through would break
    // the contract. Fall back to the caller's clock rather than failing the
    // webhook over a cosmetic field.
    const fixedNow = new Date("2026-04-22T13:30:05.000Z");
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      now: () => fixedNow,
    });
    const payload = buildPayload({ transaction_time: "nonsense" });
    const event = provider.verifyWebhookSignature(payload, {});

    expect(event.occurredAt).toBe("2026-04-22T13:30:05.000Z");
    expect(Number.isFinite(Date.parse(event.occurredAt))).toBe(true);
  });
});
