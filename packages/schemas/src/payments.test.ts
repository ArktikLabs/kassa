import { describe, expect, it } from "vitest";
import {
  qrisCreateOrderRequest,
  qrisCreateOrderResponse,
  qrisOrderStatusResponse,
} from "./payments.js";

const LOCAL_SALE_ID = "01963f8a-1234-7456-8abc-0123456789ab";
const OUTLET_ID = "01963f8a-0000-7000-8000-000000000001";

describe("qrisCreateOrderRequest", () => {
  it("accepts a minimal valid request", () => {
    const parsed = qrisCreateOrderRequest.parse({
      amount: 25_000,
      localSaleId: LOCAL_SALE_ID,
      outletId: OUTLET_ID,
    });
    expect(parsed.amount).toBe(25_000);
  });

  it("accepts an optional expiryMinutes", () => {
    const parsed = qrisCreateOrderRequest.parse({
      amount: 1,
      localSaleId: LOCAL_SALE_ID,
      outletId: OUTLET_ID,
      expiryMinutes: 15,
    });
    expect(parsed.expiryMinutes).toBe(15);
  });

  it("rejects a non-positive amount", () => {
    const res = qrisCreateOrderRequest.safeParse({
      amount: 0,
      localSaleId: LOCAL_SALE_ID,
      outletId: OUTLET_ID,
    });
    expect(res.success).toBe(false);
  });

  it("rejects a malformed outletId", () => {
    const res = qrisCreateOrderRequest.safeParse({
      amount: 25_000,
      localSaleId: LOCAL_SALE_ID,
      outletId: "not-a-uuid",
    });
    expect(res.success).toBe(false);
  });
});

describe("qrisCreateOrderResponse", () => {
  it("parses a response with an expiresAt timestamp", () => {
    const parsed = qrisCreateOrderResponse.parse({
      qrisOrderId: "ORDER-1",
      qrString: "00020101021226680013COM.MIDTRANS…",
      expiresAt: "2026-04-24T20:00:00+07:00",
    });
    expect(parsed.qrString.length).toBeGreaterThan(0);
  });

  it("accepts expiresAt null when Midtrans did not return one", () => {
    const parsed = qrisCreateOrderResponse.parse({
      qrisOrderId: "ORDER-1",
      qrString: "00020101021226680013COM.MIDTRANS…",
      expiresAt: null,
    });
    expect(parsed.expiresAt).toBeNull();
  });
});

describe("qrisOrderStatusResponse", () => {
  it("parses a paid status with a paidAt timestamp", () => {
    const parsed = qrisOrderStatusResponse.parse({
      qrisOrderId: "ORDER-1",
      status: "paid",
      grossAmount: 25_000,
      paidAt: "2026-04-24T20:00:05+07:00",
    });
    expect(parsed.status).toBe("paid");
  });

  it("parses a pending status with paidAt null", () => {
    const parsed = qrisOrderStatusResponse.parse({
      qrisOrderId: "ORDER-1",
      status: "pending",
      grossAmount: 25_000,
      paidAt: null,
    });
    expect(parsed.status).toBe("pending");
  });

  it("rejects an unknown status", () => {
    const res = qrisOrderStatusResponse.safeParse({
      qrisOrderId: "ORDER-1",
      status: "voided",
      grossAmount: 25_000,
      paidAt: null,
    });
    expect(res.success).toBe(false);
  });
});
