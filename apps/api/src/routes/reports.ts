import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  dashboardSummaryQuery,
  dashboardSummaryResponse,
  type DashboardSummaryQuery,
  type DashboardSummaryResponse,
} from "@kassa/schemas/dashboard";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { sendError } from "../lib/errors.js";
import { errorBodySchema } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { DashboardError, type DashboardService } from "../services/dashboard/index.js";

/*
 * `/v1/reports/*` — back-office reporting surface (KASA-237).
 *
 * Today there is one route, `GET /dashboard`. The shape is intentionally the
 * same JSON the v1 mobile dashboard will consume so we don't end up with two
 * subtly-different "today" rollups.
 *
 * The bootstrap-window auth posture mirrors `/v1/admin/reconciliation`: a
 * shared staff bearer token, `X-Staff-Merchant-Id`, and `X-Staff-Role`. The
 * dashboard is open to the manager-and-up tier (the AC says read-only role
 * doesn't get new permissions) — owner, manager. KASA-25 will replace the
 * pre-handler with the real session and the role list stays the same.
 */
export interface ReportsRouteDeps {
  service: DashboardService;
  /**
   * When unset the dashboard route returns 503; mirrors the same gate used by
   * `/v1/admin/reconciliation` so deploys without a staff bootstrap token
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

export function reportsRoutes(deps: ReportsRouteDeps) {
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
          "Set STAFF_BOOTSTRAP_TOKEN to enable the back-office reports surface until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireStaff(req, reply);
    };

    app.get<{ Querystring: DashboardSummaryQuery }>(
      "/dashboard",
      {
        schema: {
          tags: ["reports"],
          summary: "Back-office today-tile summary",
          description:
            "Aggregates revenue, tender mix, and top items across the " +
            "(merchant, business_date) window. Optional `outletId` narrows " +
            "to a single outlet; omit it for the cross-outlet rollup. The " +
            "JSON shape is reused by the v1 mobile dashboard.",
          response: {
            200: dashboardSummaryResponse,
            401: errorBodySchema,
            403: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedPreHandler, validate({ query: dashboardSummaryQuery })],
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
          });
          const saleCount = summary.saleCount;
          const grossIdr = summary.grossIdr;
          const taxIdr = summary.taxIdr;
          const body: DashboardSummaryResponse = {
            outletId: req.query.outletId ?? null,
            from: req.query.from,
            to: req.query.to,
            grossIdr,
            taxIdr,
            netIdr: grossIdr - taxIdr,
            saleCount,
            averageTicketIdr: saleCount > 0 ? Math.round(grossIdr / saleCount) : 0,
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
          };
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof DashboardError && err.code === "invalid_date_range") {
            sendError(reply, 422, "validation_error", err.message);
            return reply;
          }
          throw err;
        }
      },
    );
  };
}
