import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { createMidtransProvider } from "@kassa/payments";
import type {
  PaymentDomainEvent,
  TenderPaidEvent,
  TenderStatusChangedEvent,
} from "@kassa/payments";
import { buildApp } from "../src/app.js";

const SERVER_KEY = "SB-Mid-server-route-test-AAAAAAAAAAAAAAAA";

type MidtransPayload = {
  order_id: string;
  status_code: string;
  gross_amount: string;
  transaction_status: string;
  signature_key: string;
  transaction_time?: string;
  transaction_id?: string;
  fraud_status?: string;
  payment_type?: string;
};

function signed(
  partial: Omit<MidtransPayload, "signature_key">,
  key = SERVER_KEY,
): MidtransPayload {
  const signature = createHash("sha512")
    .update(
      `${partial.order_id}${partial.status_code}${partial.gross_amount}${key}`,
    )
    .digest("hex");
  return { ...partial, signature_key: signature };
}

describe("POST /v1/payments/webhooks/midtrans", () => {
  let app: FastifyInstance;
  let received: PaymentDomainEvent[];
  let pushListener: (event: PaymentDomainEvent) => void;

  beforeAll(async () => {
    app = await buildApp({
      midtransProvider: createMidtransProvider({
        serverKey: SERVER_KEY,
        environment: "sandbox",
        now: () => new Date("2026-04-22T20:30:00.000Z"),
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    received = [];
    pushListener = (event: PaymentDomainEvent) => received.push(event);
    app.events.on("tender.paid", pushListener);
    app.events.on("tender.status_changed", pushListener);
    app.webhookDedupe.clear();
  });

  afterEach(() => {
    app.events.off("tender.paid", pushListener);
    app.events.off("tender.status_changed", pushListener);
  });

  it("accepts a valid settlement, emits tender.paid and tender.status_changed", async () => {
    const payload = signed({
      order_id: "ORDER-OK-1",
      status_code: "200",
      gross_amount: "25000.00",
      transaction_status: "settlement",
      fraud_status: "accept",
      transaction_time: "2026-04-22 20:30:00",
      payment_type: "qris",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/payments/webhooks/midtrans",
      payload,
      headers: { "Content-Type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, duplicate: false });

    const paid = received.find((e): e is TenderPaidEvent => e.type === "tender.paid");
    expect(paid).toBeDefined();
    expect(paid).toMatchObject({
      provider: "midtrans",
      providerOrderId: "ORDER-OK-1",
      grossAmount: 25000,
      paidAt: "2026-04-22 20:30:00",
    });

    const changed = received.find(
      (e): e is TenderStatusChangedEvent => e.type === "tender.status_changed",
    );
    expect(changed).toBeDefined();
    expect(changed?.status).toBe("paid");
  });

  it("rejects a tampered payload with 401 and emits nothing", async () => {
    const payload = signed({
      order_id: "ORDER-BAD-1",
      status_code: "200",
      gross_amount: "10000.00",
      transaction_status: "settlement",
      fraud_status: "accept",
    });
    const tampered = { ...payload, gross_amount: "1.00" };

    const res = await app.inject({
      method: "POST",
      url: "/v1/payments/webhooks/midtrans",
      payload: tampered,
      headers: { "Content-Type": "application/json" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_signature");
    expect(received).toHaveLength(0);
  });

  it("is idempotent: replay of the same order_id+status does not double-emit", async () => {
    const payload = signed({
      order_id: "ORDER-DUPE-1",
      status_code: "200",
      gross_amount: "50000.00",
      transaction_status: "settlement",
      fraud_status: "accept",
      transaction_time: "2026-04-22 20:31:00",
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/payments/webhooks/midtrans",
      payload,
      headers: { "Content-Type": "application/json" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/payments/webhooks/midtrans",
      payload,
      headers: { "Content-Type": "application/json" },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, duplicate: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, duplicate: true });

    const paid = received.filter((e) => e.type === "tender.paid");
    expect(paid).toHaveLength(1);
    expect(app.webhookDedupe.get("ORDER-DUPE-1")?.seenCount).toBe(2);
  });

  it("treats a new transaction_status for the same order_id as a new event", async () => {
    const pending = signed({
      order_id: "ORDER-FLOW-1",
      status_code: "201",
      gross_amount: "10000.00",
      transaction_status: "pending",
    });
    const paid = signed({
      order_id: "ORDER-FLOW-1",
      status_code: "200",
      gross_amount: "10000.00",
      transaction_status: "settlement",
      fraud_status: "accept",
      transaction_time: "2026-04-22 20:40:00",
    });

    const r1 = await app.inject({
      method: "POST",
      url: "/v1/payments/webhooks/midtrans",
      payload: pending,
      headers: { "Content-Type": "application/json" },
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/payments/webhooks/midtrans",
      payload: paid,
      headers: { "Content-Type": "application/json" },
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ ok: true, duplicate: false });

    expect(received.filter((e) => e.type === "tender.status_changed")).toHaveLength(2);
    expect(received.filter((e) => e.type === "tender.paid")).toHaveLength(1);
  });

  it("rejects an empty body with 401 (missing required fields)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/payments/webhooks/midtrans",
      payload: {},
      headers: { "Content-Type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "invalid_signature",
    );
  });
});

describe("POST /v1/payments/webhooks/midtrans without a configured provider", () => {
  it("responds 503 payments_unavailable", async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/payments/webhooks/midtrans",
        payload: { anything: "goes" },
        headers: { "Content-Type": "application/json" },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "payments_unavailable",
      );
    } finally {
      await app.close();
    }
  });
});
