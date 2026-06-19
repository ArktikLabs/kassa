import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  saleIdParam,
  saleListQuery,
  saleListResponse,
  saleRefundRequest,
  saleRefundResponse,
  saleResponse,
  saleSubmitRequest,
  saleSubmitResponse,
  saleVoidRequest,
  saleVoidResponse,
  type SaleIdParam,
  type SaleListQuery,
  type SaleListResponse,
  type SaleRefundRequest,
  type SaleRefundResponse,
  type SaleResponse,
  type SaleSubmitRequest,
  type SaleSubmitResponse,
  type SaleVoidRequest,
  type SaleVoidResponse,
} from "@kassa/schemas";
import { z } from "zod";
import { notImplemented, sendError } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { SalesError, type SalesService } from "../services/sales/index.js";

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
      {
        schema: {
          tags: ["sales"],
          summary: "Submit a sale",
          description:
            "Idempotent on `(merchantId, localSaleId)` — a replay returns 409 " +
            "with the original sale envelope and an empty ledger. BOM lines " +
            "are exploded server-side against the active BOM version at sale " +
            "time. Body validation surfaces as 422 `validation_error`.",
          response: {
            201: saleSubmitResponse,
            401: errorBodySchema,
            404: errorBodySchema,
            // 409 is dual-shape: idempotent replays of the same payload
            // return `saleSubmitResponse` with an empty `ledger`; genuine
            // conflicts (insufficient stock, idempotency mismatch) return
            // the standard error envelope. The serializer compiler picks
            // whichever branch matches the outgoing body.
            409: z.union([saleSubmitResponse, errorBodySchema]),
            422: errorBodySchema,
          },
        },
        preHandler: validate({ body: saleSubmitRequest }),
      },
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
              taxIdr: outcome.existing.taxIdr,
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
            taxIdr: sale.taxIdr,
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
            if (
              err.code === "item_inactive" ||
              err.code === "outlet_merchant_mismatch" ||
              err.code === "pricing_mismatch" ||
              err.code === "synthetic_tender_mixed"
            ) {
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
      {
        schema: {
          tags: ["sales"],
          summary: "Void a sale",
          description:
            "Manager-PIN gated. Idempotent on `localVoidId` — a replayed " +
            "void with the same `localVoidId` returns 200 with empty " +
            "ledger; a different `localVoidId` against an already-voided " +
            "sale still returns 200 (the sale's `voidedAt` short-circuits " +
            "the second call). The first call returns 201 with balancing " +
            "ledger writes. Variance is owned by `voidBusinessDate`, not " +
            "the original sale's date. Only sales from the currently-open " +
            "shift on the sale's `businessDate` are voidable here; prior " +
            "shifts route through the back-office reconciliation flow.",
          response: {
            200: saleVoidResponse,
            201: saleVoidResponse,
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            409: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ params: saleIdParam, body: saleVoidRequest }),
      },
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
            localVoidId: req.body.localVoidId,
            managerStaffId: req.body.managerStaffId,
            managerPin: req.body.managerPin,
            voidedAt: req.body.voidedAt,
            voidBusinessDate: req.body.voidBusinessDate,
            reason: req.body.reason ?? null,
          });
          const { sale, ledger } = outcome.result;
          const body: SaleVoidResponse = {
            saleId: sale.id,
            localVoidId: sale.localVoidId as string,
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
      {
        schema: {
          tags: ["sales"],
          summary: "Refund a sale",
          description:
            "Idempotent on `clientRefundId` — a replay returns 200 with the " +
            "original refund body and an empty ledger. Refunded lines write " +
            "balancing positive ledger rows with `reason=refund`.",
          response: {
            200: saleRefundResponse,
            201: saleRefundResponse,
            401: errorBodySchema,
            404: errorBodySchema,
            409: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ params: saleIdParam, body: saleRefundRequest }),
      },
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

    app.get<{ Querystring: SaleListQuery }>(
      "/",
      {
        schema: {
          tags: ["sales"],
          summary: "List sales for an outlet/business date, or look up by receipt code",
          description:
            "Two modes under one path:\n\n" +
            "- `outletId` + `businessDate` returns every sale (including " +
            "voids and refunds) recorded for the (merchant, outlet, day) " +
            "bucket. The bucket is paged via an opaque `pageToken` " +
            "(round-tripped from `nextPageToken`) and an optional `limit` " +
            "(default 50, max 200). Existing clients that omit both " +
            "parameters get the first `limit=50` records exactly as " +
            "before (additive change — KASA-266). `nextPageToken` is " +
            "`null` once the bucket is exhausted.\n" +
            "- `outletId` + `receiptCode` is the KASA-370 cross-device " +
            "find-sale fallback. Cashier input is stripped of non-" +
            "alphanumerics and uppercased before matching the last six " +
            "chars of `localSaleId`. Returns the single matching sale in " +
            "the same shape as `GET /v1/sales/{saleId}`, or 404 " +
            "`sale_not_found` with copy `Struk tidak ditemukan.`. The " +
            "match is outlet-scoped: a code that collides with a sibling " +
            "outlet's sale stays a 404. `pageToken` is not valid in this " +
            "mode (validation rejects it 422).\n\n" +
            "Exactly one of `businessDate` or `receiptCode` must be " +
            "supplied (422 otherwise). A tampered `pageToken` surfaces " +
            "as 400 `invalid_page_token`.",
          response: {
            // Dual-shape 200: the list mode returns `saleListResponse`;
            // the receiptCode mode returns a single `saleResponse`. The
            // Zod serializer compiler picks whichever branch matches the
            // outgoing body.
            200: z.union([saleListResponse, saleResponse]),
            400: errorBodySchema,
            401: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ query: saleListQuery }),
      },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        if (req.query.receiptCode) {
          const sale = await deps.service.findSaleByReceiptCode(
            merchantId,
            req.query.outletId,
            req.query.receiptCode,
          );
          if (!sale) {
            // id-ID copy mirrors the POS not-found panel so a cross-device
            // fallback miss surfaces the same "Struk tidak ditemukan." line.
            sendError(reply, 404, "sale_not_found", "Struk tidak ditemukan.");
            return reply;
          }
          const body: SaleResponse = toSaleWire(sale);
          reply.code(200).send(body);
          return reply;
        }
        // saleListQuery.refine guarantees `businessDate` is present whenever
        // `receiptCode` is not.
        try {
          const page = await deps.service.listSalesByBusinessDatePage({
            merchantId,
            outletId: req.query.outletId,
            businessDate: req.query.businessDate as string,
            pageToken: req.query.pageToken,
            limit: req.query.limit,
          });
          const body: SaleListResponse = {
            records: page.records.map(toSaleWire),
            nextPageToken: page.nextPageToken,
          };
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof SalesError && err.code === "invalid_page_token") {
            // Mirror the stock-ledger error mapping (400 on a tampered
            // token). 400 not 422 here — the token is server-issued, so a
            // malformed one is a malformed request, not a validation
            // mismatch the client could "correct".
            sendError(reply, 400, err.code, err.message, err.details);
            return reply;
          }
          throw err;
        }
      },
    );

    app.get<{ Params: SaleIdParam }>(
      "/:saleId",
      {
        schema: {
          tags: ["sales"],
          summary: "Get one sale",
          description:
            "Returns the canonical sale envelope including void/refund state. " +
            "404 when the sale is not found under the caller's merchant.",
          response: {
            200: saleResponse,
            401: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ params: saleIdParam }),
      },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        const sale = await deps.service.getSale(merchantId, req.params.saleId);
        if (!sale) {
          sendError(reply, 404, "sale_not_found", `Sale ${req.params.saleId} not found.`);
          return reply;
        }
        const body: SaleResponse = toSaleWire(sale);
        reply.code(200).send(body);
        return reply;
      },
    );

    // Placeholder routes — `POST /sync` lands with the bulk sync push slice;
    // `POST /` (a non-idempotent "create" alias for /submit) is still a stub.
    app.post(
      "/",
      {
        schema: {
          tags: ["sales"],
          summary: "Create a sale (not implemented)",
          description: "Reserved non-idempotent alias for `/submit`. Returns 501.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
    );
    app.post(
      "/sync",
      {
        schema: {
          tags: ["sales"],
          summary: "Bulk sales sync (not implemented)",
          description: "Reserved for the bulk outbox push slice. Returns 501.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
    );
  };
}

function toSaleWire(sale: import("../services/sales/index.js").Sale): SaleResponse {
  return {
    saleId: sale.id,
    name: sale.name,
    localSaleId: sale.localSaleId,
    outletId: sale.outletId,
    clerkId: sale.clerkId,
    businessDate: sale.businessDate,
    subtotalIdr: sale.subtotalIdr,
    discountIdr: sale.discountIdr,
    totalIdr: sale.totalIdr,
    taxIdr: sale.taxIdr,
    items: sale.items.map((line) => ({
      itemId: line.itemId,
      bomId: line.bomId,
      quantity: line.quantity,
      uomId: line.uomId,
      unitPriceIdr: line.unitPriceIdr,
      lineTotalIdr: line.lineTotalIdr,
    })),
    tenders: sale.tenders.map((tender) => {
      const wire: SaleResponse["tenders"][number] = {
        method: tender.method,
        amountIdr: tender.amountIdr,
        reference: tender.reference,
      };
      if (tender.verified !== undefined) wire.verified = tender.verified;
      if (tender.buyerRefLast4 !== undefined) wire.buyerRefLast4 = tender.buyerRefLast4;
      return wire;
    }),
    createdAt: sale.createdAt,
    voidedAt: sale.voidedAt,
    voidBusinessDate: sale.voidBusinessDate,
    voidReason: sale.voidReason,
    localVoidId: sale.localVoidId,
    refunds: sale.refunds.map((refund) => ({
      id: refund.id,
      clientRefundId: refund.clientRefundId,
      refundedAt: refund.refundedAt,
      refundBusinessDate: refund.refundBusinessDate,
      amountIdr: refund.amountIdr,
      reason: refund.reason,
      lines: refund.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
    })),
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
    if (err.code === "void_requires_manager") {
      sendError(reply, 403, err.code, err.message, err.details);
      return reply;
    }
    if (err.code === "void_outside_open_shift") {
      sendError(reply, 422, err.code, err.message, err.details);
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
    if (err.code === "refund_idempotency_conflict" || err.code === "void_idempotency_conflict") {
      sendError(reply, 409, err.code, err.message, err.details);
      return reply;
    }
  }
  throw err;
}
