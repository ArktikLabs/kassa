import type { FastifyInstance } from "fastify";
import { saleSubmitRequest, type SaleSubmitRequest, type SaleSubmitResponse } from "@kassa/schemas";
import { notImplemented, sendError } from "../lib/errors.js";
import { validate } from "../lib/validate.js";
import { SalesError, type SalesService } from "../services/sales/index.js";

export interface SalesRouteDeps {
  service: SalesService;
  /**
   * Resolves the caller's merchantId from the authenticated request. Today
   * we pass a header-based resolver (see app.ts); KASA-25 will swap in a
   * JWT-based one without touching the route handler.
   */
  resolveMerchantId: (req: { headers: Record<string, unknown> }) => string | null;
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

    // Placeholder routes — the rest of the sale lifecycle lands with KASA-69/70.
    app.post("/", async (req, reply) => notImplemented(req, reply));
    app.get("/:saleId", async (req, reply) => notImplemented(req, reply));
    app.post("/:saleId/void", async (req, reply) => notImplemented(req, reply));
    app.post("/:saleId/refund", async (req, reply) => notImplemented(req, reply));
    app.post("/sync", async (req, reply) => notImplemented(req, reply));
  };
}
