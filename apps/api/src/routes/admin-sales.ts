import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  salesSummaryQuery,
  salesSummaryResponse,
  type SalesSummaryQuery,
  type SalesSummaryResponse,
} from "@kassa/schemas/salesSummary";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { sendError } from "../lib/errors.js";
import { errorBodySchema } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { SalesSummaryError, type SalesSummaryService } from "../services/sales-summary/index.js";

/*
 * `/v1/admin/sales/*` — period-summary surface (KASA-327).
 *
 * Today there is one route, `GET /summary`. It returns a date-range
 * roll-up (gross, discount, PPN, tender mix, refunds, top items) plus
 * a breakdown bucket picked by `groupBy=day | outlet | tender | item`.
 * The back-office "Ringkasan periode" panel + CSV / PDF export drive
 * off this single response so the wire shape is the bookkeeping format.
 *
 * The bootstrap-window auth posture mirrors `/v1/reports/dashboard` and
 * `/v1/admin/reconciliation`: a shared staff bearer token,
 * `X-Staff-Merchant-Id`, and `X-Staff-Role`. Owner + manager only;
 * KASA-25 will replace the pre-handler with the real session and the
 * role list stays the same.
 */
export interface AdminSalesRouteDeps {
  service: SalesSummaryService;
  /**
   * When unset the summary route returns 503; mirrors the same gate used
   * by `/v1/reports/dashboard` so deploys without a staff bootstrap token
   * still register the route cleanly.
   */
  staffBootstrapToken?: string;
}

function requireStaffPrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
): { userId: string; merchantId: string } | null {
  const principal = req.staffPrincipal;
  if (!principal?.merchantId) {
    sendError(reply, 401, "unauthorized", "Staff session missing.");
    return null;
  }
  return { userId: principal.userId, merchantId: principal.merchantId };
}

export function adminSalesRoutes(deps: AdminSalesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireStaff = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken, {
          allowedRoles: ["owner", "manager"],
        })
      : null;

    const gatedPreHandler = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireStaff) {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable the back-office admin-sales surface until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireStaff(req, reply);
    };

    app.get<{ Querystring: SalesSummaryQuery }>(
      "/summary",
      {
        schema: {
          tags: ["admin-sales"],
          summary: "Period sales summary for monthly bookkeeping",
          description:
            "Aggregates gross, discount, PPN, tender mix, refunds, and a " +
            "`groupBy`-keyed breakdown across the `[from, to]` business-date " +
            "window. Date range capped at 92 days — longer ranges return " +
            "`400 range_too_large` with a hint so the back-office can prompt " +
            "the merchant to narrow their pick.",
          response: {
            200: salesSummaryResponse,
            400: errorBodySchema,
            401: errorBodySchema,
            403: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedPreHandler, validate({ query: salesSummaryQuery })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        try {
          const summary = await deps.service.getSummary({
            merchantId: principal.merchantId,
            outletId: req.query.outletId ?? null,
            from: req.query.from,
            to: req.query.to,
            groupBy: req.query.groupBy,
          });
          const body: SalesSummaryResponse = {
            outletId: req.query.outletId ?? null,
            from: req.query.from,
            to: req.query.to,
            groupBy: req.query.groupBy,
            grossIdr: summary.grossIdr,
            discountIdr: summary.discountIdr,
            taxIdr: summary.taxIdr,
            netIdr: summary.grossIdr - summary.taxIdr,
            saleCount: summary.saleCount,
            refundCount: summary.refundCount,
            refundIdr: summary.refundIdr,
            tenderMix: summary.tenderMix.map((t) => ({
              method: t.method,
              amountIdr: t.amountIdr,
              count: t.count,
            })),
            topItemsByRevenue: summary.topItemsByRevenue.map((row) => ({
              itemId: row.itemId,
              name: row.name,
              revenueIdr: row.revenueIdr,
              quantity: row.quantity,
            })),
            topItemsByQuantity: summary.topItemsByQuantity.map((row) => ({
              itemId: row.itemId,
              name: row.name,
              revenueIdr: row.revenueIdr,
              quantity: row.quantity,
            })),
            groups: summary.groups.map((row) => ({
              key: row.key,
              label: row.label,
              grossIdr: row.grossIdr,
              discountIdr: row.discountIdr,
              taxIdr: row.taxIdr,
              netIdr: row.netIdr,
              saleCount: row.saleCount,
              refundCount: row.refundCount,
              refundIdr: row.refundIdr,
              quantity: row.quantity,
            })),
          };
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof SalesSummaryError) {
            if (err.code === "invalid_date_range") {
              sendError(reply, 422, "validation_error", err.message);
              return reply;
            }
            if (err.code === "range_too_large") {
              sendError(reply, 400, "range_too_large", err.message);
              return reply;
            }
          }
          throw err;
        }
      },
    );
  };
}
