import type { FastifyInstance } from "fastify";
import {
  eodCloseRequest,
  eodCloseResponse,
  eodGetResponse,
  eodIdParam,
  type EodCloseRequest,
  type EodCloseResponse,
  type EodGetResponse,
  type EodIdParam,
  type EodMissingSalesDetails,
} from "@kassa/schemas/eod";
import { notImplemented, sendError } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { EodError, type EodService } from "../services/eod/index.js";
import type { EodRecord } from "../services/eod/types.js";

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
    app.post<{ Body: EodCloseRequest }>(
      "/close",
      {
        schema: {
          tags: ["eod"],
          summary: "Close end-of-day",
          description:
            "Verifies every `clientSaleIds` entry is present, locks the " +
            "(outlet, businessDate) bucket, and returns the canonical " +
            "tender breakdown. 409 `eod_sale_mismatch` carries the missing " +
            "ids so the PWA can re-queue them.",
          response: {
            201: eodCloseResponse,
            409: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ body: eodCloseRequest }),
      },
      async (req, reply) => {
        try {
          const record = await deps.service.close({
            merchantId: deps.resolveMerchantId(),
            outletId: req.body.outletId,
            businessDate: req.body.businessDate,
            countedCashIdr: req.body.countedCashIdr,
            varianceReason: req.body.varianceReason,
            clientSaleIds: req.body.clientSaleIds,
          });
          const body: EodCloseResponse = toEodResponse(record);
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
      },
    );

    app.get(
      "/report",
      {
        schema: {
          tags: ["eod"],
          summary: "EOD report (not implemented)",
          description: "Reserved for the EOD report aggregate. Returns 501.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
    );
    app.get<{ Params: EodIdParam }>(
      "/:eodId",
      {
        schema: {
          tags: ["eod"],
          summary: "Get one EOD record",
          description:
            "Returns the canonical EOD record (counts, variance, tender " +
            "breakdown). The breakdown surfaces `qrisStaticUnverifiedCount` " +
            "so back-office can flag rows that still need a Midtrans " +
            "settlement match (KASA-197).",
          response: {
            200: eodGetResponse,
            404: errorBodySchema,
          },
        },
        preHandler: validate({ params: eodIdParam }),
      },
      async (req, reply) => {
        try {
          const record = await deps.service.get({
            merchantId: deps.resolveMerchantId(),
            eodId: req.params.eodId,
          });
          const body: EodGetResponse = toEodResponse(record);
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof EodError && err.code === "eod_not_found") {
            sendError(reply, 404, err.code, err.message);
            return reply;
          }
          throw err;
        }
      },
    );
  };
}

function toEodResponse(record: EodRecord): EodGetResponse {
  return {
    eodId: record.id,
    outletId: record.outletId,
    businessDate: record.businessDate,
    closedAt: record.closedAt,
    countedCashIdr: record.countedCashIdr,
    expectedCashIdr: record.expectedCashIdr,
    openingFloatIdr: record.openingFloatIdr,
    varianceIdr: record.varianceIdr,
    varianceReason: record.varianceReason,
    breakdown: record.breakdown,
  };
}
