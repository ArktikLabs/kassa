import { describe, expect, it } from "vitest";
import { createMidtransProvider } from "../src/providers/midtrans.js";
import { PaymentProviderError } from "../src/types.js";

const SERVER_KEY = "SB-Mid-server-test-integration-0000000000";

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? "");
    return handler(url, init);
  }) as unknown as typeof fetch;
}

describe("createMidtransProvider config", () => {
  it("throws if serverKey is empty", () => {
    expect(() => createMidtransProvider({ serverKey: "" })).toThrow(
      PaymentProviderError,
    );
  });

  it("defaults to sandbox base URL", async () => {
    let capturedUrl = "";
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch((url) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            order_id: "O1",
            qr_string: "qris:mock",
            expiry_time: "2026-04-22 21:00:00",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    });

    await provider.createQris({
      orderId: "O1",
      grossAmount: 12345,
      currency: "IDR",
      outletId: "outlet-1",
    });

    expect(capturedUrl).toBe("https://api.sandbox.midtrans.com/v2/charge");
  });

  it("uses production base URL when environment=production", async () => {
    let capturedUrl = "";
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      environment: "production",
      fetchImpl: stubFetch((url) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({ order_id: "O2", qr_string: "qris:mock" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    });

    await provider.createQris({
      orderId: "O2",
      grossAmount: 50000,
      currency: "IDR",
      outletId: "outlet-1",
    });

    expect(capturedUrl).toBe("https://api.midtrans.com/v2/charge");
  });
});

describe("createQris", () => {
  it("sends Basic auth and QRIS charge body, returns qr_string + expiresAt", async () => {
    let receivedBody: unknown;
    let receivedAuth: string | undefined;

    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch((_url, init) => {
        receivedAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
        receivedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            status_code: "201",
            order_id: "ORDER-1",
            qr_string: "00020101021126...",
            expiry_time: "2026-04-22 21:00:00",
            actions: [
              { name: "generate-qr-code", url: "https://mock-midtrans/qr/ORDER-1" },
            ],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }),
    });

    const result = await provider.createQris({
      orderId: "ORDER-1",
      grossAmount: 25000,
      currency: "IDR",
      outletId: "outlet-a",
    });

    expect(receivedAuth).toMatch(/^Basic /);
    expect(receivedBody).toMatchObject({
      payment_type: "qris",
      transaction_details: { order_id: "ORDER-1", gross_amount: 25000 },
      custom_field1: "outlet-a",
    });
    expect(result.providerOrderId).toBe("ORDER-1");
    expect(result.qrString).toBe("https://mock-midtrans/qr/ORDER-1");
    expect(result.expiresAt).toBe("2026-04-22 21:00:00");
  });

  it("throws PaymentProviderError on non-2xx response", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        new Response(
          JSON.stringify({ status_message: "invalid server key" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    });

    await expect(
      provider.createQris({
        orderId: "X",
        grossAmount: 1,
        currency: "IDR",
        outletId: "o",
      }),
    ).rejects.toMatchObject({
      code: "midtrans_charge_failed",
      status: 401,
    });
  });

  it("throws when response lacks a QR string", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        new Response(JSON.stringify({ order_id: "X" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });

    await expect(
      provider.createQris({
        orderId: "X",
        grossAmount: 1,
        currency: "IDR",
        outletId: "o",
      }),
    ).rejects.toMatchObject({ code: "midtrans_qr_missing" });
  });
});

describe("getQrisStatus", () => {
  it("maps settlement to paid and returns paidAt", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        new Response(
          JSON.stringify({
            order_id: "ORDER-1",
            transaction_status: "settlement",
            fraud_status: "accept",
            gross_amount: "25000.00",
            settlement_time: "2026-04-22 20:35:01",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    });

    const res = await provider.getQrisStatus("ORDER-1");
    expect(res.providerOrderId).toBe("ORDER-1");
    expect(res.status).toBe("paid");
    expect(res.grossAmount).toBe(25000);
    expect(res.paidAt).toBe("2026-04-22 20:35:01");
  });

  it("maps expire to expired and omits paidAt", async () => {
    const provider = createMidtransProvider({
      serverKey: SERVER_KEY,
      fetchImpl: stubFetch(() =>
        new Response(
          JSON.stringify({
            order_id: "ORDER-2",
            transaction_status: "expire",
            gross_amount: "25000.00",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    });

    const res = await provider.getQrisStatus("ORDER-2");
    expect(res.status).toBe("expired");
    expect(res.paidAt).toBeUndefined();
  });
});
