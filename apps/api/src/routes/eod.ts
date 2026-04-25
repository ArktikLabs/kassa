import type { FastifyInstance } from "fastify";
import {
  eodCloseRequest,
  type EodCloseResponse,
  type EodMissingSalesDetails,
} from "@kassa/schemas/eod";
import { notImplemented, sendError } from "../lib/errors.js";
import { EodError, type EodService } from "../services/eod/index.js";

export interface EodRouteDeps {
  service: EodService;
  /**
   * Merchant isolation will be derived from the authenticated device session
   * in KASA-25; until then every request is serviced against this bootstrap
   * merchant id so the data plane stays partitioned correctly.
   */
  resolveMerchantId: () => string;
}

export function eodRoutes(deps: EodRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/close", async (req, reply) => {
      const parsed = eodCloseRequest.safeParse(req.body);
      if (!parsed.success) {
        sendError(reply, 400, "bad_request", "Invalid request body.", parsed.error.flatten());
        return reply;
      }
      try {
        const record = await deps.service.close({
          merchantId: deps.resolveMerchantId(),
          outletId: parsed.data.outletId,
          businessDate: parsed.data.businessDate,
          countedCashIdr: parsed.data.countedCashIdr,
          varianceReason: parsed.data.varianceReason,
          clientSaleIds: parsed.data.clientSaleIds,
        });
        const body: EodCloseResponse = {
          eodId: record.id,
          outletId: record.outletId,
          businessDate: record.businessDate,
          closedAt: record.closedAt,
          countedCashIdr: record.countedCashIdr,
          expectedCashIdr: record.expectedCashIdr,
          varianceIdr: record.varianceIdr,
          varianceReason: record.varianceReason,
          breakdown: record.breakdown,
        };
        reply.code(201).send(body);
        return reply;
      } catch (err) {
        if (err instanceof EodError) {
          if (err.code === "eod_sale_mismatch") {
            const details: EodMissingSalesDetails = err.details ?? {
              expectedCount: 0,
              receivedCount: 0,
              missingSaleIds: [],
            };
            sendError(reply, 409, err.code, err.message, details);
            return reply;
          }
          if (err.code === "eod_already_closed") {
            sendError(reply, 409, err.code, err.message);
            return reply;
          }
          if (err.code === "eod_variance_reason_required") {
            sendError(reply, 422, err.code, err.message);
            return reply;
          }
        }
        throw err;
      }
    });

    app.get("/report", async (req, reply) => notImplemented(req, reply));
    app.get("/:eodId", async (req, reply) => notImplemented(req, reply));
  };
}
