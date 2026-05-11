import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { notImplemented, sendError } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { buildEodCsv, eodCsvFilename, type EodCsvShiftInput } from "../services/eod/csv.js";
import { EodError, type EodService } from "../services/eod/index.js";
import type { EodRecord } from "../services/eod/types.js";

/**
 * Narrow lookup port for the CSV export route. The full
 * `OutletsRepository` surface (pagination, page tokens) is not needed
 * here — keeping the port small means a deploy that has not yet wired
 * the Pg outlets repository can still register the route by passing an
 * in-memory or stub reader.
 */
export interface EodCsvOutletReader {
  findById(input: {
    merchantId: string;
    outletId: string;
  }): Promise<{ id: string; code: string; name: string } | null>;
}

/**
 * Narrow port for the shift join that feeds `shift_open_at`,
 * `shift_close_at`, and `cashier`. Matches `ShiftReader.findShiftForBusinessDate`
 * (services/shifts/repository.ts) — we redeclare the slice here so the
 * eod route only depends on the columns it renders.
 */
export interface EodCsvShiftReader {
  findShiftForBusinessDate(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<{
    cashierStaffId: string;
    openedAt: string;
    closedAt: string | null;
  } | null>;
}

/**
 * Narrow port for resolving the cashier display name. Optional: when
 * omitted (or when the staff id is not found) the CSV renders the staff
 * UUID as the cashier value so the bookkeeper still gets a stable
 * identifier per row.
 */
export interface EodCsvStaffReader {
  findById(input: {
    merchantId: string;
    staffId: string;
  }): Promise<{ id: string; displayName: string } | null>;
}

export interface EodRouteDeps {
  service: EodService;
  /**
   * Merchant isolation will be derived from the authenticated device session
   * in KASA-25; until then every request is serviced against this bootstrap
   * merchant id so the data plane stays partitioned correctly.
   */
  resolveMerchantId: () => string;
  /**
   * Bootstrap-window staff session (KASA-25 will replace it). When unset
   * the CSV export route returns 503 `staff_bootstrap_disabled` so the
   * route still registers cleanly on deploys without the token; the
   * device-auth-gated EOD close + read endpoints are unaffected.
   */
  staffBootstrapToken?: string;
  /**
   * Required when `staffBootstrapToken` is set — without an outlet reader
   * the CSV cannot resolve the `outlet` column or the `Content-Disposition`
   * filename slug.
   */
  outletReader?: EodCsvOutletReader;
  /** Optional — see `EodCsvShiftReader`. */
  shiftReader?: EodCsvShiftReader;
  /** Optional — see `EodCsvStaffReader`. */
  staffReader?: EodCsvStaffReader;
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
    /**
     * KASA-250 — per-outlet, per-date EOD reconciliation CSV.
     *
     * Owner/manager only; the cashier sees a `Forbidden` row action and
     * a direct hit on the URL is 403. The body is `text/csv; charset=utf-8`
     * with a UTF-8 BOM so Excel-id reads it without an import wizard, and
     * the `;` separator matches the Indonesian Excel default. Filename is
     * pinned via `Content-Disposition` so the browser saves
     * `kassa-eod-{outletCodeSlug}-{YYYY-MM-DD}.csv` even when the URL is
     * shared.
     */
    const requireCsvStaff = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken, {
          allowedRoles: ["owner", "manager"],
        })
      : null;
    const csvGatedPreHandler = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireCsvStaff) {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable the back-office EOD CSV export until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireCsvStaff(req, reply);
    };

    app.get<{ Params: EodIdParam }>(
      "/:eodId/export.csv",
      {
        schema: {
          tags: ["eod"],
          summary: "Download EOD reconciliation CSV (owner/manager)",
          description:
            "Server-rendered CSV per the KASA-250 contract: UTF-8 BOM, " +
            "`;` separator, RFC-4180 quoting, plain integer rupiah. " +
            "Owner-or-manager only — cashier and read-only roles get 403.",
          response: {
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [csvGatedPreHandler, validate({ params: eodIdParam })],
      },
      async (req, reply) => {
        const principal = req.staffPrincipal;
        if (!principal?.merchantId) {
          sendError(reply, 401, "unauthorized", "Staff session missing.");
          return reply;
        }
        if (!deps.outletReader) {
          sendError(
            reply,
            503,
            "staff_bootstrap_disabled",
            "EOD CSV export requires an outlet reader; none is configured.",
          );
          return reply;
        }
        let record: EodRecord;
        try {
          record = await deps.service.get({
            merchantId: principal.merchantId,
            eodId: req.params.eodId,
          });
        } catch (err) {
          if (err instanceof EodError && err.code === "eod_not_found") {
            sendError(reply, 404, err.code, err.message);
            return reply;
          }
          throw err;
        }
        const outlet = await deps.outletReader.findById({
          merchantId: principal.merchantId,
          outletId: record.outletId,
        });
        if (!outlet) {
          // The EOD row resolved but the outlet didn't — should be
          // impossible (FK keeps them in lock-step) but we map it to
          // the same 404 envelope rather than a 500 so callers see a
          // single failure mode and Sentry doesn't page on a benign
          // race during outlet rename.
          sendError(reply, 404, "eod_not_found", `EOD ${req.params.eodId} not found.`);
          return reply;
        }
        const shift = deps.shiftReader
          ? await deps.shiftReader.findShiftForBusinessDate({
              merchantId: principal.merchantId,
              outletId: record.outletId,
              businessDate: record.businessDate,
            })
          : null;
        let shiftInput: EodCsvShiftInput | null = null;
        if (shift) {
          const cashierName = deps.staffReader
            ? ((
                await deps.staffReader.findById({
                  merchantId: principal.merchantId,
                  staffId: shift.cashierStaffId,
                })
              )?.displayName ?? shift.cashierStaffId)
            : shift.cashierStaffId;
          shiftInput = {
            openedAt: shift.openedAt,
            closedAt: shift.closedAt,
            cashier: cashierName,
          };
        }
        const body = buildEodCsv({
          eod: record,
          outlet: { name: outlet.name, code: outlet.code },
          shift: shiftInput,
        });
        const filename = eodCsvFilename(outlet.code, record.businessDate);
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
