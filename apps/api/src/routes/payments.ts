import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type NormalizedWebhookEvent, WebhookSignatureError } from "@kassa/payments";
import { notImplemented, sendError } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";

const orderIdParam = z.object({ orderId: z.string().min(1) }).strict();

const webhookAckResponse = z
  .object({
    ok: z.literal(true),
    duplicate: z.boolean(),
  })
  .strict()
  .describe(
    "Acknowledgement returned to the payment provider. `duplicate: true` " +
      "means the event was already processed and no domain event was emitted.",
  );

export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/qris",
    {
      schema: {
        tags: ["payments"],
        summary: "Create a QRIS charge (not implemented)",
        description:
          "Will create a QRIS payment intent via the active provider. Lands with KASA-63.",
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.get(
    "/qris/:orderId/status",
    {
      schema: {
        tags: ["payments"],
        summary: "Poll QRIS charge status (not implemented)",
        description:
          "Will poll the active provider for the latest charge status. Lands with KASA-63.",
        params: orderIdParam,
        response: notImplementedResponses,
      },
    },
    async (req, reply) => notImplemented(req, reply),
  );
  app.post(
    "/webhooks/midtrans",
    {
      schema: {
        tags: ["payments"],
        summary: "Midtrans payment webhook",
        description:
          "Receives Midtrans payment notifications. Verifies the HMAC-SHA512 " +
          "`signature_key` with a timing-safe compare, normalizes " +
          "`transaction_status + fraud_status` to one of " +
          "`pending | paid | failed | expired | cancelled`, and dedupes " +
          "by `(orderId, normalized status)` so capture+settlement collapse " +
          "to a single `tender.paid` domain event. Returns 503 " +
          "`payments_unavailable` when `MIDTRANS_SERVER_KEY` is unset.",
        response: {
          200: webhookAckResponse,
          401: errorBodySchema,
          503: errorBodySchema,
        },
      },
    },
    midtransWebhookHandler,
  );
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
