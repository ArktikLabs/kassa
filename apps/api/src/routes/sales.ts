import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  saleRefundRequest,
  saleSubmitRequest,
  saleVoidRequest,
  type SaleRefundRequest,
  type SaleRefundResponse,
  type SaleSubmitRequest,
  type SaleSubmitResponse,
  type SaleVoidRequest,
  type SaleVoidResponse,
} from "@kassa/schemas";
import { z } from "zod";
import { notImplemented, sendError } from "../lib/errors.js";
import { validate } from "../lib/validate.js";
import { SalesError, type SalesService } from "../services/sales/index.js";

const uuidV7Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const saleIdParam = z
  .object({ saleId: z.string().regex(uuidV7Regex, "saleId must be a UUIDv7") })
  .strict();
type SaleIdParam = z.infer<typeof saleIdParam>;

export interface SalesRouteDeps {
  service: SalesService;
  /**
   * Resolves the caller's merchantId from the authenticated request. The
   * default resolver in app.ts prefers `req.devicePrincipal.merchantId`
   * (set by the device-auth preHandler) and falls back to the
   * `x-kassa-merchant-id` header for the legacy bootstrap callers.
   */
  resolveMerchantId: (req: FastifyRequest) => string | null;
}

export function salesRoutes(deps: SalesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post<{ Body: SaleSubmitRequest }>(
      "/submit",
      { preHandler: validate({ body: saleSubmitRequest }) },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }

        try {
          const outcome = await deps.service.submit({ merchantId, ...req.body });
          if (outcome.kind === "conflict") {
            const body: SaleSubmitResponse = {
              saleId: outcome.existing.id,
              name: outcome.existing.name,
              localSaleId: outcome.existing.localSaleId,
              outletId: outcome.existing.outletId,
              createdAt: outcome.existing.createdAt,
              ledger: [],
            };
            reply.code(409).send(body);
            return reply;
          }
          const { sale, ledger } = outcome.result;
          const body: SaleSubmitResponse = {
            saleId: sale.id,
            name: sale.name,
            localSaleId: sale.localSaleId,
            outletId: sale.outletId,
            createdAt: sale.createdAt,
            ledger: ledger.map((entry) => ({
              id: entry.id,
              outletId: entry.outletId,
              itemId: entry.itemId,
              delta: entry.delta,
              reason: entry.reason,
              refType: entry.refType,
              refId: entry.refId,
              occurredAt: entry.occurredAt,
            })),
          };
          reply.code(201).send(body);
          return reply;
        } catch (err) {
          if (err instanceof SalesError) {
            if (err.code === "outlet_not_found" || err.code === "item_not_found") {
              sendError(reply, 404, err.code, err.message, err.details);
              return reply;
            }
            if (err.code === "bom_not_found") {
              sendError(reply, 422, err.code, err.message, err.details);
              return reply;
            }
            if (err.code === "insufficient_stock") {
              sendError(reply, 409, err.code, err.message, err.details);
              return reply;
            }
            if (err.code === "idempotency_conflict") {
              sendError(reply, 409, err.code, err.message, err.details);
              return reply;
            }
            if (err.code === "item_inactive" || err.code === "outlet_merchant_mismatch") {
              sendError(reply, 422, err.code, err.message, err.details);
              return reply;
            }
          }
          throw err;
        }
      },
    );

    app.post<{ Params: SaleIdParam; Body: SaleVoidRequest }>(
      "/:saleId/void",
      { preHandler: validate({ params: saleIdParam, body: saleVoidRequest }) },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        try {
          const outcome = await deps.service.void({
            merchantId,
            saleId: req.params.saleId,
            voidedAt: req.body.voidedAt,
            voidBusinessDate: req.body.voidBusinessDate,
            reason: req.body.reason ?? null,
          });
          const { sale, ledger } = outcome.result;
          const body: SaleVoidResponse = {
            saleId: sale.id,
            voidedAt: sale.voidedAt as string,
            voidBusinessDate: sale.voidBusinessDate as string,
            reason: sale.voidReason,
            ledger: ledger.map(toLedgerWire),
          };
          reply.code(outcome.created ? 201 : 200).send(body);
          return reply;
        } catch (err) {
          return mapSalesError(err, reply);
        }
      },
    );

    app.post<{ Params: SaleIdParam; Body: SaleRefundRequest }>(
      "/:saleId/refund",
      { preHandler: validate({ params: saleIdParam, body: saleRefundRequest }) },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        try {
          const outcome = await deps.service.refund({
            merchantId,
            saleId: req.params.saleId,
            clientRefundId: req.body.clientRefundId,
            refundedAt: req.body.refundedAt,
            refundBusinessDate: req.body.refundBusinessDate,
            amountIdr: req.body.amountIdr,
            reason: req.body.reason ?? null,
            lines: req.body.lines,
          });
          const { sale, refund, ledger } = outcome.result;
          const body: SaleRefundResponse = {
            saleId: sale.id,
            refundId: refund.id,
            clientRefundId: refund.clientRefundId,
            refundedAt: refund.refundedAt,
            refundBusinessDate: refund.refundBusinessDate,
            amountIdr: refund.amountIdr,
            reason: refund.reason,
            ledger: ledger.map(toLedgerWire),
          };
          reply.code(outcome.created ? 201 : 200).send(body);
          return reply;
        } catch (err) {
          return mapSalesError(err, reply);
        }
      },
    );

    // Placeholder routes — the rest of the sale lifecycle lands with PR3
    // (sale GET + list + stock ledger).
    app.post("/", async (req, reply) => notImplemented(req, reply));
    app.get("/:saleId", async (req, reply) => notImplemented(req, reply));
    app.post("/sync", async (req, reply) => notImplemented(req, reply));
  };
}

function toLedgerWire(entry: {
  id: string;
  outletId: string;
  itemId: string;
  delta: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  occurredAt: string;
}) {
  return {
    id: entry.id,
    outletId: entry.outletId,
    itemId: entry.itemId,
    delta: entry.delta,
    reason: entry.reason as SaleVoidResponse["ledger"][number]["reason"],
    refType: entry.refType,
    refId: entry.refId,
    occurredAt: entry.occurredAt,
  };
}

function mapSalesError(err: unknown, reply: import("fastify").FastifyReply) {
  if (err instanceof SalesError) {
    if (err.code === "sale_not_found") {
      sendError(reply, 404, err.code, err.message, err.details);
      return reply;
    }
    if (
      err.code === "sale_voided" ||
      err.code === "sale_has_refunds" ||
      err.code === "refund_line_not_in_sale" ||
      err.code === "refund_quantity_exceeds_remaining" ||
      err.code === "refund_amount_exceeds_remaining"
    ) {
      sendError(reply, 422, err.code, err.message, err.details);
      return reply;
    }
    if (err.code === "refund_idempotency_conflict") {
      sendError(reply, 409, err.code, err.message, err.details);
      return reply;
    }
  }
  throw err;
}
