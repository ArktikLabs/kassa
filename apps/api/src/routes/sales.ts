import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notImplemented, sendError } from "../lib/errors.js";
import type { EodService } from "../services/eod/index.js";
import type { SaleRecord, SaleTenderMethod } from "../services/eod/types.js";

const uuidV7 = z.string().uuid();
const rupiahInteger = z.number().int().nonnegative();

/*
 * The client-facing sales push contract. This is the minimum surface EOD
 * needs: we accept the canonical `pending_sales` wire shape the outbox
 * drain sends (see `apps/pos/src/data/sync/push.ts`), record the sale
 * in the ledger keyed on (merchantId, localSaleId), and return `{ name }`
 * so the push drain can set `serverSaleName` on its Dexie row.
 *
 * Full CRUD + void/refund endpoints land in KASA-59 / KASA-63; this shim
 * is only what KASA-65 (EOD close) needs to reconcile a real sale stream.
 */
const saleSubmitRequest = z
  .object({
    localSaleId: uuidV7,
    outletId: uuidV7,
    clerkId: z.string().min(1),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    createdAt: z.string().datetime({ offset: true }),
    subtotalIdr: rupiahInteger,
    discountIdr: rupiahInteger,
    totalIdr: rupiahInteger,
    items: z
      .array(
        z
          .object({
            itemId: uuidV7,
            bomId: uuidV7.nullable(),
            quantity: z.number().positive(),
            uomId: uuidV7,
            unitPriceIdr: rupiahInteger,
            lineTotalIdr: rupiahInteger,
          })
          .strict(),
      )
      .min(1),
    tenders: z
      .array(
        z
          .object({
            method: z.enum(["cash", "qris", "card", "other"]),
            amountIdr: rupiahInteger,
            reference: z.string().nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export interface SalesRouteDeps {
  eodService: EodService;
  resolveMerchantId: () => string;
}

function mapTenderMethod(method: "cash" | "qris" | "card" | "other"): SaleTenderMethod {
  // KASA-74 (payments reconciliation) will split QRIS into dynamic/static
  // based on webhook evidence. Until then every wire-`qris` is recorded as
  // `qris_static` so the "unverified" bucket is truthful.
  if (method === "qris") return "qris_static";
  return method;
}

export function salesRoutes(deps: SalesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/submit", async (req, reply) => {
      const parsed = saleSubmitRequest.safeParse(req.body);
      if (!parsed.success) {
        sendError(reply, 400, "bad_request", "Invalid sale payload.", parsed.error.flatten());
        return reply;
      }
      const record: SaleRecord = {
        localSaleId: parsed.data.localSaleId,
        merchantId: deps.resolveMerchantId(),
        outletId: parsed.data.outletId,
        clerkId: parsed.data.clerkId,
        businessDate: parsed.data.businessDate,
        createdAt: parsed.data.createdAt,
        subtotalIdr: parsed.data.subtotalIdr,
        discountIdr: parsed.data.discountIdr,
        totalIdr: parsed.data.totalIdr,
        items: parsed.data.items.map((i) => ({
          itemId: i.itemId,
          quantity: i.quantity,
          unitPriceIdr: i.unitPriceIdr,
          lineTotalIdr: i.lineTotalIdr,
        })),
        tenders: parsed.data.tenders.map((t) => ({
          method: mapTenderMethod(t.method),
          amountIdr: t.amountIdr,
          reference: t.reference,
        })),
        voidedAt: null,
      };
      const outcome = await deps.eodService.upsertSale(record);
      // The push drain encodes idempotency as `serverSaleName` on `pending_sales`;
      // today we mirror the local id back so the DB-backed impl can swap it
      // for a human-friendly sale number without any wire change.
      const name = `sale-${parsed.data.localSaleId}`;
      if (outcome.status === "duplicate") {
        reply.code(409).send({ name });
        return reply;
      }
      reply.code(201).send({ name });
      return reply;
    });

    // Still stubbed — the full CRUD/void surface lands in KASA-59.
    app.post("/", async (req, reply) => notImplemented(req, reply));
    app.get("/:saleId", async (req, reply) => notImplemented(req, reply));
    app.post("/:saleId/void", async (req, reply) => notImplemented(req, reply));
    app.post("/:saleId/refund", async (req, reply) => notImplemented(req, reply));
    app.post("/sync", async (req, reply) => notImplemented(req, reply));
  };
}
