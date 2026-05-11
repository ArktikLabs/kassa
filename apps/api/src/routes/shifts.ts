import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  shiftCloseRequest,
  shiftCloseResponse,
  shiftCurrentQuery,
  shiftCurrentResponse,
  shiftOpenRequest,
  shiftOpenResponse,
  type ShiftCloseRequest,
  type ShiftCloseResponse,
  type ShiftCurrentQuery,
  type ShiftCurrentResponse,
  type ShiftOpenRequest,
  type ShiftOpenResponse,
} from "@kassa/schemas/shifts";
import { sendError } from "../lib/errors.js";
import { errorBodySchema } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { ShiftError, type ShiftsService } from "../services/shifts/index.js";
import type { ShiftRecord } from "../services/shifts/types.js";

export interface ShiftsRouteDeps {
  service: ShiftsService;
  /**
   * Resolves the caller's merchantId from the authenticated request. Same
   * resolver pattern as `salesRoutes` — defaults to `req.devicePrincipal`
   * with the legacy `x-kassa-merchant-id` header fallback during the
   * device-auth rollout.
   */
  resolveMerchantId: (req: FastifyRequest) => string | null;
}

/*
 * Routes for the cashier shift open/close flow (KASA-235).
 *
 *   POST /v1/shifts/open    — idempotent on `(merchantId, openShiftId)`
 *   POST /v1/shifts/close   — idempotent on `(merchantId, closeShiftId)`
 *   GET  /v1/shifts/current — resolves the open shift for (outlet, cashier)
 *
 * The PWA outbox replays through Workbox BackgroundSync; the unique-key
 * idempotency turns every retry into either the original response (200)
 * or a 409 surfacing the conflict.
 */
export function shiftsRoutes(deps: ShiftsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post<{ Body: ShiftOpenRequest }>(
      "/open",
      {
        schema: {
          tags: ["shifts"],
          summary: "Open a cashier shift",
          description:
            "Records the starting cash float for a cashier on a given " +
            "(outlet, business_date). Idempotent on `(merchantId, " +
            "openShiftId)` — a retried push with the same id and same " +
            "payload returns the original row at 200; a different payload " +
            "reusing the id is a 409 `shift_idempotency_conflict`.",
          response: {
            200: shiftOpenResponse,
            201: shiftOpenResponse,
            401: errorBodySchema,
            409: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ body: shiftOpenRequest }),
      },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        try {
          const before = await deps.service.current({
            merchantId,
            outletId: req.body.outletId,
            cashierStaffId: req.body.cashierStaffId,
          });
          const idempotent = before !== null && before.openShiftId === req.body.openShiftId;
          const record = await deps.service.open({
            merchantId,
            openShiftId: req.body.openShiftId,
            outletId: req.body.outletId,
            cashierStaffId: req.body.cashierStaffId,
            businessDate: req.body.businessDate,
            openedAt: req.body.openedAt,
            openingFloatIdr: req.body.openingFloatIdr,
          });
          const body: ShiftOpenResponse = toShiftResponse(record);
          reply.code(idempotent ? 200 : 201).send(body);
          return reply;
        } catch (err) {
          if (err instanceof ShiftError) {
            if (err.code === "shift_idempotency_conflict") {
              sendError(reply, 409, err.code, err.message);
              return reply;
            }
          }
          throw err;
        }
      },
    );

    app.post<{ Body: ShiftCloseRequest }>(
      "/close",
      {
        schema: {
          tags: ["shifts"],
          summary: "Close a cashier shift",
          description:
            "Records the counted cash drawer total at end of shift. " +
            "Idempotent on `(merchantId, closeShiftId)`. The server " +
            "derives `expectedCashIdr = openingFloatIdr + cashSalesIdr` " +
            "and `varianceIdr = countedCashIdr − expectedCashIdr`.",
          response: {
            200: shiftCloseResponse,
            401: errorBodySchema,
            404: errorBodySchema,
            409: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ body: shiftCloseRequest }),
      },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        try {
          const record = await deps.service.close({
            merchantId,
            closeShiftId: req.body.closeShiftId,
            openShiftId: req.body.openShiftId,
            closedAt: req.body.closedAt,
            countedCashIdr: req.body.countedCashIdr,
          });
          const body: ShiftCloseResponse = toShiftResponse(record);
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof ShiftError) {
            if (err.code === "shift_not_found") {
              sendError(reply, 404, err.code, err.message);
              return reply;
            }
            if (err.code === "shift_close_idempotency_conflict" || err.code === "shift_not_open") {
              sendError(reply, 409, err.code, err.message);
              return reply;
            }
          }
          throw err;
        }
      },
    );

    app.get<{ Querystring: ShiftCurrentQuery }>(
      "/current",
      {
        schema: {
          tags: ["shifts"],
          summary: "Get the current open shift",
          description:
            "Resolves the open shift for the (outlet, cashier) bucket. " +
            "Returns 404 when no shift is currently open so the PWA boot " +
            "guard can route the cashier to `/shift/open` deterministically.",
          response: {
            200: shiftCurrentResponse,
            401: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ query: shiftCurrentQuery }),
      },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        const record = await deps.service.current({
          merchantId,
          outletId: req.query.outletId,
          cashierStaffId: req.query.cashierStaffId,
        });
        if (!record) {
          sendError(reply, 404, "shift_not_found", "No open shift for this cashier.");
          return reply;
        }
        const body: ShiftCurrentResponse = toShiftResponse(record);
        reply.code(200).send(body);
        return reply;
      },
    );
  };
}

function toShiftResponse(record: ShiftRecord): ShiftCurrentResponse {
  return {
    shiftId: record.id,
    outletId: record.outletId,
    cashierStaffId: record.cashierStaffId,
    businessDate: record.businessDate,
    status: record.status,
    openShiftId: record.openShiftId,
    openedAt: record.openedAt,
    openingFloatIdr: record.openingFloatIdr,
    closeShiftId: record.closeShiftId,
    closedAt: record.closedAt,
    countedCashIdr: record.countedCashIdr,
    expectedCashIdr: record.expectedCashIdr,
    varianceIdr: record.varianceIdr,
  };
}
