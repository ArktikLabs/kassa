import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  stockLedgerPullQuery,
  stockLedgerPullResponse,
  stockPullResponse,
  stockSnapshotQuery,
  type StockLedgerEntry as WireStockLedgerEntry,
  type StockLedgerPullQuery,
  type StockLedgerPullResponse,
  type StockPullResponse,
  type StockSnapshotQuery,
  type StockSnapshotRecord,
} from "@kassa/schemas";
import { sendError } from "../lib/errors.js";
import { errorBodySchema } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { SalesError, type SalesService } from "../services/sales/index.js";
import type { SalesRepository } from "../services/sales/index.js";

export interface StockRouteDeps {
  repository: SalesRepository;
  /**
   * Sales service exposes `listLedger` for the read-side stock ledger
   * endpoint. The route shares the SalesService that owns ledger writes so
   * a single backing in-memory store serves both writes (sale submit /
   * void / refund) and reads.
   */
  service: SalesService;
  resolveMerchantId: (req: FastifyRequest) => string | null;
  now?: () => Date;
}

export function stockRoutes(deps: StockRouteDeps) {
  const now = deps.now ?? (() => new Date());
  return async function register(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: StockSnapshotQuery }>(
      "/snapshot",
      {
        schema: {
          tags: ["stock"],
          summary: "Stock on-hand snapshot",
          description:
            "Returns the full per-(outlet, item) on-hand projection. " +
            "`updatedAfter` and `pageToken` are accepted but currently ignored " +
            "— they live in the schema so the shared sync runner can " +
            "round-trip the cursor on every cycle.",
          response: {
            200: stockPullResponse,
            401: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ query: stockSnapshotQuery }),
      },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        const outletId = req.query.outlet;
        const outlet = await deps.repository.findOutlet(merchantId, outletId);
        if (!outlet) {
          sendError(reply, 404, "outlet_not_found", `Outlet ${outletId} is not registered.`);
          return reply;
        }
        const onHand = await deps.repository.allOnHandForOutlet(outletId);
        const updatedAt = now().toISOString();
        const records: StockSnapshotRecord[] = [...onHand.entries()].map(([itemId, qty]) => ({
          outletId,
          itemId,
          onHand: qty,
          updatedAt,
        }));
        const body: StockPullResponse = stockPullResponse.parse({
          records,
          nextCursor: updatedAt,
          nextPageToken: null,
        });
        reply.send(body);
        return reply;
      },
    );

    // GET /v1/stock/ledger?outletId=&updatedAfter=&pageToken=&limit=
    // Append-only ledger projection — the acceptance suite (KASA-68) reads
    // this after the offline outbox drains to assert correct BOM deductions.
    app.get<{ Querystring: StockLedgerPullQuery }>(
      "/ledger",
      {
        schema: {
          tags: ["stock"],
          summary: "Pull stock ledger (delta)",
          description:
            "Append-only ledger projection scoped to one (merchant, outlet) " +
            "bucket. Order is `(occurredAt ASC, id ASC)`. The acceptance " +
            "suite (KASA-68) reads this after the offline outbox drains to " +
            "assert correct BOM deductions.",
          response: {
            200: stockLedgerPullResponse,
            400: errorBodySchema,
            401: errorBodySchema,
            422: errorBodySchema,
          },
        },
        preHandler: validate({ query: stockLedgerPullQuery }),
      },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        try {
          const result = await deps.service.listLedger({
            merchantId,
            outletId: req.query.outletId,
            ...(req.query.updatedAfter !== undefined
              ? { updatedAfter: new Date(req.query.updatedAfter) }
              : {}),
            ...(req.query.pageToken !== undefined ? { pageToken: req.query.pageToken } : {}),
            ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
          });
          const body: StockLedgerPullResponse = {
            records: result.records.map(
              (entry): WireStockLedgerEntry => ({
                id: entry.id,
                outletId: entry.outletId,
                itemId: entry.itemId,
                delta: entry.delta,
                reason: entry.reason,
                refType: entry.refType,
                refId: entry.refId,
                occurredAt: entry.occurredAt,
              }),
            ),
            nextCursor: result.nextCursor ? result.nextCursor.toISOString() : null,
            nextPageToken: result.nextPageToken,
          };
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof SalesError && err.code === "invalid_page_token") {
            sendError(reply, 400, "invalid_page_token", err.message);
            return reply;
          }
          throw err;
        }
      },
    );
  };
}
