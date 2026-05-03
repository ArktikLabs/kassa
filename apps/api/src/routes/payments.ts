import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type NormalizedWebhookEvent,
  PaymentProviderError,
  WebhookSignatureError,
} from "@kassa/payments";
import {
  midtransWebhookAck,
  qrisCreateOrderRequest,
  qrisCreateOrderResponse,
  qrisOrderStatusResponse,
  type QrisCreateOrderRequest,
  type QrisCreateOrderResponse,
  type QrisOrderStatus,
  type QrisOrderStatusResponse,
} from "@kassa/schemas/payments";
import type { DeviceAuthPreHandler } from "../auth/device-auth.js";
import { sendError } from "../lib/errors.js";
import { errorBodySchema } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";

export function paymentsRoutes(requireDevice: DeviceAuthPreHandler) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post<{ Body: QrisCreateOrderRequest }>(
      "/qris",
      {
        schema: {
          tags: ["payments"],
          summary: "Create a dynamic QRIS order",
          description:
            "Mints a Midtrans QRIS order keyed off the POS `localSaleId` so " +
            "the webhook callback maps 1:1 against the outbox row. Returns " +
            "`qrString` for QR rendering and the optional `expiresAt` " +
            "Midtrans returned. 502 on Midtrans 5xx / network failure / " +
            "auth misconfig — the PWA falls back to static QRIS in that case.",
          response: {
            201: qrisCreateOrderResponse,
            401: errorBodySchema,
            422: errorBodySchema,
            502: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [requireDevice, validate({ body: qrisCreateOrderRequest })],
      },
      createQrisOrderHandler,
    );
    app.get<{ Params: { orderId: string } }>(
      "/qris/:orderId/status",
      {
        schema: {
          tags: ["payments"],
          summary: "Poll a QRIS order status",
          description:
            "Read-through to Midtrans for the canonical order status. The POS " +
            "polls this until `paid`/`expired`/`cancelled` while waiting for " +
            "the webhook. 502 on upstream outage; 503 when Midtrans is not " +
            "configured on this instance.",
          response: {
            200: qrisOrderStatusResponse,
            400: errorBodySchema,
            401: errorBodySchema,
            502: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: requireDevice,
      },
      getQrisOrderStatusHandler,
    );
    // The Midtrans webhook authenticates via HMAC signature on the body, not
    // device credentials, so it stays outside the `requireDevice` gate.
    app.post(
      "/webhooks/midtrans",
      {
        schema: {
          tags: ["payments"],
          summary: "Midtrans webhook delivery",
          description:
            "Authenticated by HMAC signature on the request body, not device " +
            "credentials. Deduped on (`providerOrderId`, `status`); a " +
            "redelivery returns 200 with `duplicate: true` so Midtrans " +
            "considers the event accepted. 401 on signature mismatch; 503 " +
            "when Midtrans is not configured.",
          response: {
            200: midtransWebhookAck,
            401: errorBodySchema,
            503: errorBodySchema,
          },
        },
      },
      midtransWebhookHandler,
    );
  };
}

async function createQrisOrderHandler(
  req: FastifyRequest<{ Body: QrisCreateOrderRequest }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const provider = req.server.midtransProvider;
  if (!provider) {
    return sendError(
      reply,
      503,
      "payments_unavailable",
      "Payments provider is not configured on this instance.",
    );
  }

  // The POS's `localSaleId` (UUIDv7) is the Midtrans `order_id`. Using it
  // directly avoids an extra lookup table on the webhook path — the paid
  // callback arrives already keyed to the outbox row the PWA will finalise.
  try {
    const result = await provider.createQris({
      orderId: req.body.localSaleId,
      grossAmount: req.body.amount,
      currency: "IDR",
      outletId: req.body.outletId,
      ...(req.body.expiryMinutes !== undefined ? { expiryMinutes: req.body.expiryMinutes } : {}),
    });
    const body: QrisCreateOrderResponse = {
      qrisOrderId: result.providerOrderId,
      qrString: result.qrString,
      expiresAt: result.expiresAt ?? null,
    };
    reply.code(201).send(body);
    return reply;
  } catch (err) {
    return handleProviderError(req, reply, err, "qris_create_failed");
  }
}

async function getQrisOrderStatusHandler(
  req: FastifyRequest<{ Params: { orderId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const provider = req.server.midtransProvider;
  if (!provider) {
    return sendError(
      reply,
      503,
      "payments_unavailable",
      "Payments provider is not configured on this instance.",
    );
  }

  const { orderId } = req.params;
  if (typeof orderId !== "string" || orderId.trim() === "") {
    return sendError(reply, 400, "bad_request", "orderId is required.");
  }

  try {
    const result = await provider.getQrisStatus(orderId);
    const body: QrisOrderStatusResponse = {
      qrisOrderId: result.providerOrderId,
      status: result.status as QrisOrderStatus,
      grossAmount: result.grossAmount,
      paidAt: result.paidAt ?? null,
    };
    reply.code(200).send(body);
    return reply;
  } catch (err) {
    return handleProviderError(req, reply, err, "qris_status_failed");
  }
}

function handleProviderError(
  req: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  fallbackCode: string,
): FastifyReply {
  if (err instanceof PaymentProviderError) {
    const upstream = err.status ?? 0;
    // Midtrans 4xx is a genuine client error (bad amount, dup order); Midtrans
    // 5xx / network failures are upstream outages, which we surface as 502 so
    // the PWA can fall back to static QRIS without retrying the same request.
    // 401/403 mean our server key is missing or wrong — that's a config
    // problem on our side, not something the PWA can act on, so we collapse
    // those into 502 too instead of leaking auth state downstream.
    const isClientFixable =
      upstream >= 400 && upstream < 500 && upstream !== 401 && upstream !== 403;
    const status = isClientFixable ? upstream : 502;
    req.log.warn({ err, providerCode: err.code }, "midtrans request failed");
    return sendError(reply, status, err.code, err.message);
  }
  req.log.error({ err }, "unexpected payment provider failure");
  return sendError(reply, 500, fallbackCode, "Unexpected error from the payments provider.");
}

async function midtransWebhookHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const app = req.server;
  const provider = app.midtransProvider;

  if (!provider) {
    req.log.warn("midtrans webhook received but no provider configured; set MIDTRANS_SERVER_KEY");
    return sendError(
      reply,
      503,
      "payments_unavailable",
      "Payments provider is not configured on this instance.",
    );
  }

  let event: NormalizedWebhookEvent;
  try {
    event = provider.verifyWebhookSignature(req.body, req.headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      req.log.warn({ err }, "midtrans webhook signature rejected");
      return sendError(reply, 401, "invalid_signature", err.message);
    }
    throw err;
  }

  // Dedupe on the normalized status so Midtrans's capture + settlement
  // (both of which collapse to "paid") don't double-emit tender.paid.
  if (app.webhookDedupe.check(event.providerOrderId, event.status)) {
    req.log.info(
      {
        provider: provider.name,
        providerOrderId: event.providerOrderId,
        status: event.status,
      },
      "midtrans webhook duplicate; skipping event emit",
    );
    return reply.code(200).send({ ok: true, duplicate: true });
  }

  try {
    app.events.emit({
      type: "tender.status_changed",
      provider: provider.name,
      providerOrderId: event.providerOrderId,
      status: event.status,
      grossAmount: event.grossAmount,
      occurredAt: event.occurredAt,
    });

    if (event.status === "paid") {
      app.events.emit({
        type: "tender.paid",
        provider: provider.name,
        providerOrderId: event.providerOrderId,
        grossAmount: event.grossAmount,
        paidAt: event.occurredAt,
      });
    }
  } catch (err) {
    // A listener threw — don't mark this delivery as deduped so Midtrans's
    // retry re-delivers the event instead of it being silently dropped.
    req.log.error(
      { err, providerOrderId: event.providerOrderId, status: event.status },
      "event listener failed; dedupe not recorded so retry can re-emit",
    );
    throw err;
  }

  app.webhookDedupe.record(event.providerOrderId, event.status);

  return reply.code(200).send({ ok: true, duplicate: false });
}
