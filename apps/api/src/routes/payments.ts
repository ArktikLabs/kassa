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

  const rawStatus =
    typeof req.body === "object" && req.body !== null
      ? ((req.body as Record<string, unknown>)["transaction_status"] as
          | string
          | undefined)
      : undefined;
  const dedupeKey = rawStatus ?? event.status;
  const duplicate = app.webhookDedupe.checkAndRecord(
    event.providerOrderId,
    dedupeKey,
  );

  if (duplicate) {
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

  return reply.code(200).send({ ok: true, duplicate: false });
}
