import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  dashboardSummaryQuery,
  dashboardSummaryResponse,
  type DashboardSummaryQuery,
  type DashboardSummaryResponse,
} from "@kassa/schemas/dashboard";
import {
  cashierDayQuery,
  cashierDayResponse,
  type CashierDayQuery,
  type CashierDayResponse,
  type CashierDayTenderSlice as WireCashierDayTenderSlice,
} from "@kassa/schemas/reports";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { sendError } from "../lib/errors.js";
import { errorBodySchema } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import {
  buildCashierDayCsv,
  cashierDayCsvFilename,
  type CashierDayService,
  type CashierDayTenderMethod,
} from "../services/cashier-day/index.js";
import { DashboardError, type DashboardService } from "../services/dashboard/index.js";

/**
 * Narrow outlet lookup. The cashier-day CSV export uses the outlet's `code`
 * to slug the filename; for the JSON route we use the lookup only to detect
 * the outlet-belongs-to-merchant case so a cross-tenant outlet id returns the
 * same empty shape (`rows: []`) as a date with no sales — never leaks
 * cross-tenant existence.
 */
export interface CashierDayOutletReader {
  findById(input: {
    merchantId: string;
    outletId: string;
  }): Promise<{ id: string; code: string; name: string } | null>;
}

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
   * KASA-368 — per-cashier daily report aggregator. When omitted the route
   * registers but every request returns 503 `cashier_day_disabled`, mirroring
   * the dashboard's bootstrap-window gate. Wired by `buildApp` against an
   * in-memory repository by default so a `buildApp({})` boot still answers
   * the route with the canonical empty shape.
   */
  cashierDay?: CashierDayService;
  /**
   * Required for the CSV export route. Resolves the outlet's `code` so the
   * `Content-Disposition` filename slug is stable. When omitted the CSV route
   * still registers and returns 503 `outlet_reader_disabled`.
   */
  cashierDayOutletReader?: CashierDayOutletReader;
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

    /**
     * KASA-368 — per-cashier daily report.
     *
     * One row per cashier who had ≥ 1 sale or void on `businessDate`. Voids
     * are attributed to the original cashier on `voidBusinessDate`, matching
     * the EOD variance convention so the owner gets one source of truth
     * across this page and the EOD reconciliation tile.
     *
     * Cross-tenant scoping: the staff principal's merchant id seals the
     * query; an outlet that belongs to another merchant returns the same
     * empty `rows: []` shape as a date with no sales so existence does not
     * leak across tenants.
     */
    const cashierDayService = deps.cashierDay;
    app.get<{ Querystring: CashierDayQuery }>(
      "/cashier-day",
      {
        schema: {
          tags: ["reports"],
          summary: "Per-cashier daily sales report",
          description:
            "Aggregates a single (outlet, business_date) bucket into per-" +
            "cashier rows: sale count, gross, void count + total, tender mix " +
            "(cash / QRIS dynamic / QRIS static), and the expected drawer " +
            "(opening float + cash net) when the matched shift carries one. " +
            "Owner-or-manager only.",
          response: {
            200: cashierDayResponse,
            401: errorBodySchema,
            403: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedPreHandler, validate({ query: cashierDayQuery })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        if (!cashierDayService) {
          sendError(
            reply,
            503,
            "cashier_day_disabled",
            "Cashier-day reporter not configured; bind `reports.cashierDay` in buildApp.",
          );
          return reply;
        }
        const result = await cashierDayService.getReport({
          merchantId: principal.merchantId,
          outletId: req.query.outletId,
          businessDate: req.query.businessDate,
        });
        const body: CashierDayResponse = toCashierDayResponse(
          req.query.outletId,
          req.query.businessDate,
          result.rows,
        );
        reply.code(200).send(body);
        return reply;
      },
    );

    /**
     * Server-rendered CSV variant. Same RBAC + tenancy as the JSON route,
     * `Content-Disposition` pins the filename so the bookkeeper's downloads
     * folder shows `kassa-cashier-day-{outletCodeSlug}-{YYYY-MM-DD}.csv`. The
     * body is `text/csv; charset=utf-8` with a UTF-8 BOM and `;` separator
     * (id-ID Excel default).
     */
    const cashierDayOutletReader = deps.cashierDayOutletReader;
    app.get<{ Querystring: CashierDayQuery }>(
      "/cashier-day/export.csv",
      {
        schema: {
          tags: ["reports"],
          summary: "Download per-cashier daily sales CSV (owner/manager)",
          description:
            "Same rows as `GET /cashier-day` plus a totals row. UTF-8 BOM, " +
            "`;` separator, RFC-4180 quoting, plain integer rupiah.",
          response: {
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedPreHandler, validate({ query: cashierDayQuery })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        if (!cashierDayService) {
          sendError(
            reply,
            503,
            "cashier_day_disabled",
            "Cashier-day reporter not configured; bind `reports.cashierDay` in buildApp.",
          );
          return reply;
        }
        if (!cashierDayOutletReader) {
          sendError(
            reply,
            503,
            "outlet_reader_disabled",
            "Cashier-day CSV export requires an outlet reader; none is configured.",
          );
          return reply;
        }
        const outlet = await cashierDayOutletReader.findById({
          merchantId: principal.merchantId,
          outletId: req.query.outletId,
        });
        if (!outlet) {
          sendError(reply, 404, "outlet_not_found", `Outlet ${req.query.outletId} not found.`);
          return reply;
        }
        const result = await cashierDayService.getReport({
          merchantId: principal.merchantId,
          outletId: req.query.outletId,
          businessDate: req.query.businessDate,
        });
        const report = toCashierDayResponse(
          req.query.outletId,
          req.query.businessDate,
          result.rows,
        );
        const body = buildCashierDayCsv({ report, totalsLabel: "Total" });
        const filename = cashierDayCsvFilename(outlet.code, req.query.businessDate);
        reply
          .code(200)
          .header("content-type", "text/csv; charset=utf-8")
          .header(
            "content-disposition",
            `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          )
          .send(body);
        return reply;
      },
    );
  };
}

/**
 * Project the repository's per-cashier aggregates into the wire shape:
 *   - derive `netIdr = grossIdr − voidIdr` (server-derived so the client
 *     doesn't subtract);
 *   - sum the per-cashier rows into a totals block, including a tender-mix
 *     totals slice keyed by method;
 *   - propagate `drawerExpectedIdr === null` through the totals: if every
 *     row's drawer is null (e.g. no shift opened anywhere) the totals row's
 *     drawer is also null so the UI renders "—" instead of "Rp 0".
 */
function toCashierDayResponse(
  outletId: string,
  businessDate: string,
  rows: ReadonlyArray<{
    cashierStaffId: string;
    cashierName: string;
    saleCount: number;
    grossIdr: number;
    voidCount: number;
    voidIdr: number;
    tenderMix: readonly { method: CashierDayTenderMethod; amountIdr: number; count: number }[];
    drawerExpectedIdr: number | null;
  }>,
): CashierDayResponse {
  const tenderTotals = new Map<CashierDayTenderMethod, { amountIdr: number; count: number }>();
  let saleCount = 0;
  let grossIdr = 0;
  let voidCount = 0;
  let voidIdr = 0;
  let drawerTotal = 0;
  let anyDrawer = false;

  const wireRows = rows.map((row) => {
    saleCount += row.saleCount;
    grossIdr += row.grossIdr;
    voidCount += row.voidCount;
    voidIdr += row.voidIdr;
    if (row.drawerExpectedIdr !== null) {
      drawerTotal += row.drawerExpectedIdr;
      anyDrawer = true;
    }
    for (const slice of row.tenderMix) {
      const slot = tenderTotals.get(slice.method) ?? { amountIdr: 0, count: 0 };
      slot.amountIdr += slice.amountIdr;
      slot.count += slice.count;
      tenderTotals.set(slice.method, slot);
    }
    return {
      cashierStaffId: row.cashierStaffId,
      cashierName: row.cashierName,
      saleCount: row.saleCount,
      grossIdr: row.grossIdr,
      netIdr: row.grossIdr - row.voidIdr,
      voidCount: row.voidCount,
      voidIdr: row.voidIdr,
      tenderMix: row.tenderMix.map((slice) => ({
        method: slice.method,
        amountIdr: slice.amountIdr,
        count: slice.count,
      })),
      drawerExpectedIdr: row.drawerExpectedIdr,
    };
  });

  const totalsTenderMix: WireCashierDayTenderSlice[] = [...tenderTotals.entries()]
    .map(([method, totals]) => ({ method, amountIdr: totals.amountIdr, count: totals.count }))
    .sort((a, b) => b.amountIdr - a.amountIdr || a.method.localeCompare(b.method));

  return {
    outletId,
    businessDate,
    rows: wireRows,
    totals: {
      saleCount,
      grossIdr,
      netIdr: grossIdr - voidIdr,
      voidCount,
      voidIdr,
      tenderMix: totalsTenderMix,
      drawerExpectedIdr: anyDrawer ? drawerTotal : null,
    },
  };
}
