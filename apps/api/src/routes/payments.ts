import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebhookSignatureError } from "@kassa/payments";
import { notImplemented, sendError } from "../lib/errors.js";

export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/qris", async (req, reply) => notImplemented(req, reply));
  app.get("/qris/:orderId/status", async (req, reply) => notImplemented(req, reply));
  app.post("/webhooks/midtrans", midtransWebhookHandler);
}

async function midtransWebhookHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const app = req.server;
  const provider = app.midtransProvider;

  if (!provider) {
    req.log.warn(
      "midtrans webhook received but no provider configured; set MIDTRANS_SERVER_KEY",
    );
    return sendError(
      reply,
      503,
      "payments_unavailable",
      "Payments provider is not configured on this instance.",
    );
  }

  let event;
  try {
    event = provider.verifyWebhookSignature(req.body, req.headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      req.log.warn({ err }, "midtrans webhook signature rejected");
      return sendError(reply, 401, "invalid_signature", err.message);
    }
    throw err;
  }

  // Surface the silent clock swap so ops can correlate a suspicious occurredAt
  // with a real Midtrans payload. Deliberately omit the raw payload: it can
  // carry signature_key and other PII-adjacent fields.
  if (event.malformedProviderTimestamp !== undefined) {
    req.log.warn(
      {
        provider: provider.name,
        providerOrderId: event.providerOrderId,
        rawTransactionTime: event.malformedProviderTimestamp,
        occurredAt: event.occurredAt,
      },
      "midtrans webhook transaction_time unparseable; fell back to server clock",
    );
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
