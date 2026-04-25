import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMidtransProvider } from "@kassa/payments";
import { buildApp } from "../src/app.js";

/*
 * Integration tests for the QRIS tender side-channel (ARCHITECTURE.md §3.1
 * Flow C). We build a real Fastify app wired to the real Midtrans provider
 * but stub the outbound fetch so every test controls the Midtrans response
 * shape without hitting the sandbox over the network.
 */

const SERVER_KEY = "SB-Mid-server-qris-test-AAAAAAAAAAAAAAAA";
const LOCAL_SALE_ID = "01963f8a-1234-7456-8abc-0123456789ab";
const OUTLET_ID = "01963f8a-0000-7000-8000-000000000001";

interface FakeResponse {
  status: number;
  body: Record<string, unknown>;
}

function stubbedFetch(
  responses: Record<string, FakeResponse>,
  captured: { calls: Array<{ url: string; init?: RequestInit }> },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.calls.push({ url, ...(init !== undefined ? { init } : {}) });
    // Match on the path portion so tests don't hinge on the sandbox host.
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const match = responses[path] ?? responses[url];
    if (!match) {
      throw new Error(`no stub for ${url}`);
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("POST /v1/payments/qris", () => {
  it("returns 503 payments_unavailable when no provider is configured", async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/payments/qris",
        payload: { amount: 25_000, localSaleId: LOCAL_SALE_ID, outletId: OUTLET_ID },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe("payments_unavailable");
    } finally {
      await app.close();
    }
  });

  it("validates the request body and returns 400 on bad input", async () => {
    const app = await buildApp({
      midtransProvider: createMidtransProvider({
        serverKey: SERVER_KEY,
        environment: "sandbox",
      }),
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/payments/qris",
        payload: { amount: -1, localSaleId: LOCAL_SALE_ID, outletId: OUTLET_ID },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("bad_request");
    } finally {
      await app.close();
    }
  });

  it("creates an order via Midtrans and returns qrString, qrisOrderId, expiresAt", async () => {
    const captured: { calls: Array<{ url: string; init?: RequestInit }> } = { calls: [] };
    const fetchImpl = stubbedFetch(
      {
        "/v2/charge": {
          status: 201,
          body: {
            status_code: "201",
            order_id: LOCAL_SALE_ID,
            qr_string: "00020101021226680013COM.MIDTRANS0118936009140000000000",
            expiry_time: "2026-04-24 20:15:00",
            gross_amount: "25000.00",
            actions: [
              {
                name: "generate-qr-code",
                url: "https://api.sandbox.midtrans.com/v2/qris/qr",
              },
            ],
          },
        },
      },
      captured,
    );

    const app = await buildApp({
      midtransProvider: createMidtransProvider({
        serverKey: SERVER_KEY,
        environment: "sandbox",
        fetchImpl,
        now: () => new Date("2026-04-24T13:00:00.000Z"),
      }),
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/payments/qris",
        payload: {
          amount: 25_000,
          localSaleId: LOCAL_SALE_ID,
          outletId: OUTLET_ID,
          expiryMinutes: 15,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        qrisOrderId: string;
        qrString: string;
        expiresAt: string | null;
      };
      expect(body).toMatchObject({
        qrisOrderId: LOCAL_SALE_ID,
        qrString: "00020101021226680013COM.MIDTRANS0118936009140000000000",
        expiresAt: "2026-04-24 20:15:00",
      });

      // Midtrans was called once, with the POS localSaleId as order_id so the
      // webhook can key the paid callback against the outbox row directly.
      expect(captured.calls).toHaveLength(1);
      const sent = JSON.parse(String(captured.calls[0]?.init?.body)) as {
        transaction_details: { order_id: string; gross_amount: number };
        custom_expiry?: { expiry_duration: number };
      };
      expect(sent.transaction_details.order_id).toBe(LOCAL_SALE_ID);
      expect(sent.transaction_details.gross_amount).toBe(25_000);
      expect(sent.custom_expiry?.expiry_duration).toBe(15);
    } finally {
      await app.close();
    }
  });

  it("surfaces a Midtrans 4xx as the same status code", async () => {
    const captured: { calls: Array<{ url: string; init?: RequestInit }> } = { calls: [] };
    const fetchImpl = stubbedFetch(
      {
        "/v2/charge": {
          status: 400,
          body: { status_code: "400", status_message: "order_id has been taken" },
        },
      },
      captured,
    );

    const app = await buildApp({
      midtransProvider: createMidtransProvider({
        serverKey: SERVER_KEY,
        environment: "sandbox",
        fetchImpl,
      }),
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/payments/qris",
        payload: { amount: 25_000, localSaleId: LOCAL_SALE_ID, outletId: OUTLET_ID },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("midtrans_charge_failed");
    } finally {
      await app.close();
    }
  });

  it("surfaces a Midtrans 5xx as a 502 so the PWA can fall back to static QRIS", async () => {
    const captured: { calls: Array<{ url: string; init?: RequestInit }> } = { calls: [] };
    const fetchImpl = stubbedFetch(
      {
        "/v2/charge": {
          status: 503,
          body: { status_code: "503", status_message: "service unavailable" },
        },
      },
      captured,
    );

    const app = await buildApp({
      midtransProvider: createMidtransProvider({
        serverKey: SERVER_KEY,
        environment: "sandbox",
        fetchImpl,
      }),
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/payments/qris",
        payload: { amount: 25_000, localSaleId: LOCAL_SALE_ID, outletId: OUTLET_ID },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/payments/qris/:orderId/status", () => {
  let app: FastifyInstance;
  const captured: { calls: Array<{ url: string; init?: RequestInit }> } = { calls: [] };
  const statusFor = (status: string, extra: Record<string, unknown> = {}): FakeResponse => ({
    status: 200,
    body: {
      status_code: "200",
      order_id: LOCAL_SALE_ID,
      transaction_status: status,
      fraud_status: "accept",
      gross_amount: "25000.00",
      ...extra,
    },
  });

  const responses: Record<string, FakeResponse> = {
    [`/v2/${LOCAL_SALE_ID}/status`]: statusFor("pending"),
  };

  beforeAll(async () => {
    app = await buildApp({
      midtransProvider: createMidtransProvider({
        serverKey: SERVER_KEY,
        environment: "sandbox",
        fetchImpl: stubbedFetch(responses, captured),
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with status=pending while Midtrans reports pending", async () => {
    responses[`/v2/${LOCAL_SALE_ID}/status`] = statusFor("pending");
    const res = await app.inject({
      method: "GET",
      url: `/v1/payments/qris/${LOCAL_SALE_ID}/status`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      qrisOrderId: LOCAL_SALE_ID,
      status: "pending",
      grossAmount: 25_000,
      paidAt: null,
    });
  });

  it("returns status=paid with paidAt ISO-with-offset on settlement", async () => {
    responses[`/v2/${LOCAL_SALE_ID}/status`] = statusFor("settlement", {
      settlement_time: "2026-04-24 20:00:05",
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/payments/qris/${LOCAL_SALE_ID}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; paidAt: string | null };
    expect(body.status).toBe("paid");
    // The payments provider hands through the Midtrans `settlement_time`
    // verbatim; normalisation is the webhook handler's job.
    expect(body.paidAt).toBe("2026-04-24 20:00:05");
  });

  it("returns status=expired when Midtrans reports expire", async () => {
    responses[`/v2/${LOCAL_SALE_ID}/status`] = statusFor("expire");
    const res = await app.inject({
      method: "GET",
      url: `/v1/payments/qris/${LOCAL_SALE_ID}/status`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("expired");
  });

  it("returns status=cancelled when Midtrans reports cancel", async () => {
    responses[`/v2/${LOCAL_SALE_ID}/status`] = statusFor("cancel");
    const res = await app.inject({
      method: "GET",
      url: `/v1/payments/qris/${LOCAL_SALE_ID}/status`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("cancelled");
  });
});

describe("GET /v1/payments/qris/:orderId/status without a configured provider", () => {
  it("responds 503 payments_unavailable", async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/payments/qris/${LOCAL_SALE_ID}/status`,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
