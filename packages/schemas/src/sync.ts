import { z } from "zod";

/*
 * Wire schemas for the read-through sync engine (ARCHITECTURE.md §3.1 Flow A).
 *
 * Every reference-data endpoint returns the same envelope shape so the
 * client can share one pull loop. Cursors are opaque ISO-8601 strings;
 * page tokens are opaque server-issued strings for paginating within a
 * single cursor window. Both may be null independently.
 */

const uuidV7 = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });
const rupiahInteger = z.number().int().nonnegative();

export const syncCursor = z.string().datetime({ offset: true }).nullable();
export type SyncCursor = z.infer<typeof syncCursor>;

export const syncPageToken = z.string().min(1).max(512).nullable();
export type SyncPageToken = z.infer<typeof syncPageToken>;

/**
 * Shared query schema for every reference-data pull endpoint
 * (`GET /v1/outlets`, `/v1/catalog/boms`, `/v1/catalog/uoms`, `/v1/catalog/items`).
 * `updatedAfter` is the cursor returned by the previous response (`nextCursor`);
 * `pageToken` is the opaque within-window page key (`nextPageToken`). Pass one
 * or the other per request; `pageToken` wins if both are present. `limit` is
 * clamped server-side to the per-resource maximum.
 */
export const referencePullQuery = z
  .object({
    updatedAfter: isoTimestamp.optional(),
    pageToken: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ReferencePullQuery = z.infer<typeof referencePullQuery>;

function envelope<T extends z.ZodTypeAny>(record: T) {
  return z
    .object({
      records: z.array(record),
      nextCursor: syncCursor,
      nextPageToken: syncPageToken,
    })
    .strict();
}

export const outletRecord = z
  .object({
    id: uuidV7,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(256),
    timezone: z.string().min(1).max(64),
    updatedAt: isoTimestamp,
  })
  .strict();
export type OutletRecord = z.infer<typeof outletRecord>;

export const uomRecord = z
  .object({
    id: uuidV7,
    code: z.string().min(1).max(32),
    name: z.string().min(1).max(128),
    updatedAt: isoTimestamp,
  })
  .strict();
export type UomRecord = z.infer<typeof uomRecord>;

export const itemRecord = z
  .object({
    id: uuidV7,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(256),
    priceIdr: rupiahInteger,
    uomId: uuidV7,
    bomId: uuidV7.nullable(),
    isStockTracked: z.boolean(),
    isActive: z.boolean(),
    updatedAt: isoTimestamp,
  })
  .strict();
export type ItemRecord = z.infer<typeof itemRecord>;

export const bomComponent = z
  .object({
    componentItemId: uuidV7,
    quantity: z.number().positive(),
    uomId: uuidV7,
  })
  .strict();
export type BomComponentRecord = z.infer<typeof bomComponent>;

export const bomRecord = z
  .object({
    id: uuidV7,
    itemId: uuidV7,
    components: z.array(bomComponent).min(1),
    updatedAt: isoTimestamp,
  })
  .strict();
export type BomRecord = z.infer<typeof bomRecord>;

export const stockSnapshotRecord = z
  .object({
    outletId: uuidV7,
    itemId: uuidV7,
    onHand: z.number().finite(),
    updatedAt: isoTimestamp,
  })
  .strict();
export type StockSnapshotRecord = z.infer<typeof stockSnapshotRecord>;

export const outletPullResponse = envelope(outletRecord);
export type OutletPullResponse = z.infer<typeof outletPullResponse>;

export const itemPullResponse = envelope(itemRecord);
export type ItemPullResponse = z.infer<typeof itemPullResponse>;

export const bomPullResponse = envelope(bomRecord);
export type BomPullResponse = z.infer<typeof bomPullResponse>;

export const uomPullResponse = envelope(uomRecord);
export type UomPullResponse = z.infer<typeof uomPullResponse>;

export const stockPullResponse = envelope(stockSnapshotRecord);
export type StockPullResponse = z.infer<typeof stockPullResponse>;

/*
 * `POST /v1/sales/submit` — KASA-66. The client posts the same shape Dexie
 * stores in `pending_sales`; we re-use the field names so the wire contract
 * is the serialised row, not a translated DTO. Server explodes BOMs against
 * the active BOM version at sale time and writes per-component ledger rows.
 * Idempotency key on the server is (merchantId, localSaleId) — replays return
 * the same `saleId` body with 200, but the sales pipeline treats a duplicate
 * `localSaleId` that disagrees on lines as 409.
 */

const uuidV7Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV7Typed = z.string().regex(uuidV7Regex, "must be a UUIDv7");
const rupiahAmount = z.number().int().nonnegative();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const saleSubmitItem = z
  .object({
    itemId: uuidV7Typed,
    bomId: uuidV7Typed.nullable(),
    quantity: z.number().positive(),
    uomId: uuidV7Typed,
    unitPriceIdr: rupiahAmount,
    lineTotalIdr: rupiahAmount,
  })
  .strict();
export type SaleSubmitItem = z.infer<typeof saleSubmitItem>;

export const saleSubmitTender = z
  .object({
    method: z.enum(["cash", "qris", "qris_static", "card", "other"]),
    amountIdr: rupiahAmount,
    reference: z.string().nullable(),
    /**
     * Server-confirmed against an upstream settlement record. Always `false`
     * for `qris_static` at write time; reconciliation flips it on the
     * server. Optional on the wire so legacy clients keep validating.
     */
    verified: z.boolean().optional(),
    /**
     * Last 4 digits of the buyer's QRIS reference (KASA-118). Required for
     * `qris_static`; absent for every other method. Lets the back-office
     * matcher disambiguate same-amount tenders.
     */
    buyerRefLast4: z
      .string()
      .regex(/^\d{4}$/, "must be exactly 4 digits")
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.method === "qris_static") {
      if (!value.buyerRefLast4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["buyerRefLast4"],
          message: "qris_static tenders require buyerRefLast4",
        });
      }
      if (value.verified === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verified"],
          message: "qris_static tenders are unverified at write time",
        });
      }
    }
  });
export type SaleSubmitTender = z.infer<typeof saleSubmitTender>;

export const saleSubmitRequest = z
  .object({
    localSaleId: uuidV7Typed,
    outletId: uuidV7Typed,
    clerkId: z.string().min(1),
    businessDate,
    createdAt: isoTimestamp,
    subtotalIdr: rupiahAmount,
    discountIdr: rupiahAmount,
    totalIdr: rupiahAmount,
    items: z.array(saleSubmitItem).min(1),
    tenders: z.array(saleSubmitTender).min(1),
  })
  .strict();
export type SaleSubmitRequest = z.infer<typeof saleSubmitRequest>;

/**
 * Stock-ledger reason values mirror the server drizzle enum
 * (`stockLedgerReasonValues` in apps/api/src/db/schema/stock.ts). v0 only
 * writes `"sale"` from this endpoint; the other values are reserved for the
 * void/refund and replenishment endpoints (KASA-69/70).
 */
export const stockLedgerReason = z.enum([
  "sale",
  "sale_void",
  "refund",
  "receipt",
  "adjustment",
  "transfer_in",
  "transfer_out",
  "reconcile",
]);
export type StockLedgerReason = z.infer<typeof stockLedgerReason>;

export const stockLedgerEntry = z
  .object({
    id: uuidV7Typed,
    outletId: uuidV7Typed,
    itemId: uuidV7Typed,
    delta: z.number().finite(),
    reason: stockLedgerReason,
    /** Back-link shape `(refType, refId)` — "sale" + saleId for sale writes. */
    refType: z.string().nullable(),
    refId: uuidV7Typed.nullable(),
    occurredAt: isoTimestamp,
  })
  .strict();
export type StockLedgerEntry = z.infer<typeof stockLedgerEntry>;

export const saleSubmitResponse = z
  .object({
    saleId: uuidV7Typed,
    /** Server-canonical sale name shown in receipts / back-office. */
    name: z.string().min(1),
    localSaleId: uuidV7Typed,
    outletId: uuidV7Typed,
    createdAt: isoTimestamp,
    ledger: z.array(stockLedgerEntry),
  })
  .strict();
export type SaleSubmitResponse = z.infer<typeof saleSubmitResponse>;

/*
 * `POST /v1/sales/:saleId/void` — KASA-122 PR2. Cancels an entire sale:
 * the server writes per-component balancing ledger rows with `reason="sale_void"`
 * and stamps `voidedAt` on the sale row so EOD variance owns the cancellation
 * on `voidBusinessDate`. Idempotent on `saleId` — a second void returns 200
 * with the originally recorded `voidedAt`/empty ledger.
 */
const voidReason = z.string().min(1).max(256).optional();

export const saleVoidRequest = z
  .object({
    voidedAt: isoTimestamp,
    voidBusinessDate: businessDate,
    reason: voidReason,
  })
  .strict();
export type SaleVoidRequest = z.infer<typeof saleVoidRequest>;

export const saleVoidResponse = z
  .object({
    saleId: uuidV7Typed,
    voidedAt: isoTimestamp,
    voidBusinessDate: businessDate,
    reason: z.string().nullable(),
    /**
     * Balancing ledger writes (positive deltas mirroring the original sale's
     * negative entries). Empty on idempotent replay since the rows were
     * written by the first void.
     */
    ledger: z.array(stockLedgerEntry),
  })
  .strict();
export type SaleVoidResponse = z.infer<typeof saleVoidResponse>;

/*
 * `POST /v1/sales/:saleId/refund` — KASA-122 PR2. Books a refund (full or
 * partial). The client supplies `clientRefundId` (uuidv7) for idempotency;
 * a replay returns the original refund body with empty ledger. Each refunded
 * line writes a balancing positive ledger row with `reason="refund"`.
 */
export const saleRefundLine = z
  .object({
    itemId: uuidV7Typed,
    quantity: z.number().positive(),
  })
  .strict();
export type SaleRefundLine = z.infer<typeof saleRefundLine>;

export const saleRefundRequest = z
  .object({
    clientRefundId: uuidV7Typed,
    refundedAt: isoTimestamp,
    refundBusinessDate: businessDate,
    amountIdr: rupiahAmount,
    lines: z.array(saleRefundLine).min(1),
    reason: voidReason,
  })
  .strict();
export type SaleRefundRequest = z.infer<typeof saleRefundRequest>;

export const saleRefundResponse = z
  .object({
    saleId: uuidV7Typed,
    refundId: uuidV7Typed,
    clientRefundId: uuidV7Typed,
    refundedAt: isoTimestamp,
    refundBusinessDate: businessDate,
    amountIdr: rupiahAmount,
    reason: z.string().nullable(),
    ledger: z.array(stockLedgerEntry),
  })
  .strict();
export type SaleRefundResponse = z.infer<typeof saleRefundResponse>;

/*
 * `GET /v1/sales/:saleId` and `GET /v1/sales?outletId=&businessDate=` —
 * KASA-122 PR3. The acceptance suite uses these to assert "all 50 sales are
 * present server-side with matching totals" after the offline outbox drains.
 * The response shape is the full Sale row — including void/refund state —
 * so the suite can also assert lifecycle correctness without re-fetching.
 */
export const saleRefundRecord = z
  .object({
    id: uuidV7Typed,
    clientRefundId: uuidV7Typed,
    refundedAt: isoTimestamp,
    refundBusinessDate: businessDate,
    amountIdr: rupiahAmount,
    reason: z.string().nullable(),
    lines: z.array(saleRefundLine),
  })
  .strict();
export type SaleRefundRecord = z.infer<typeof saleRefundRecord>;

export const saleResponse = z
  .object({
    saleId: uuidV7Typed,
    name: z.string().min(1),
    localSaleId: uuidV7Typed,
    outletId: uuidV7Typed,
    clerkId: z.string().min(1),
    businessDate,
    subtotalIdr: rupiahAmount,
    discountIdr: rupiahAmount,
    totalIdr: rupiahAmount,
    items: z.array(saleSubmitItem),
    tenders: z.array(saleSubmitTender),
    createdAt: isoTimestamp,
    voidedAt: isoTimestamp.nullable(),
    voidBusinessDate: businessDate.nullable(),
    voidReason: z.string().nullable(),
    refunds: z.array(saleRefundRecord),
  })
  .strict();
export type SaleResponse = z.infer<typeof saleResponse>;

export const saleListQuery = z
  .object({
    outletId: uuidV7Typed,
    businessDate,
  })
  .strict();
export type SaleListQuery = z.infer<typeof saleListQuery>;

/**
 * No pagination on the list endpoint: the bucket key (merchant, outlet,
 * businessDate) caps cardinality at one outlet's daily sale volume — the
 * acceptance suite tops out at 50 sales/day/outlet. If real-world merchants
 * later breach that, add `pageToken` here without breaking the wire.
 */
export const saleListResponse = z
  .object({
    records: z.array(saleResponse),
  })
  .strict();
export type SaleListResponse = z.infer<typeof saleListResponse>;

/*
 * `GET /v1/stock/ledger?outletId=&updatedAfter=&pageToken=&limit=` —
 * KASA-122 PR4. Append-only stock-ledger projection scoped to one
 * (merchant, outlet) bucket. The acceptance suite (KASA-68) reads this
 * after the offline outbox drains to assert "correct BOM deductions in
 * Stock Ledger" — every sale, void, and refund writes one row per
 * exploded BOM component with a signed `delta`.
 *
 * Ordering is `(occurredAt ASC, id ASC)`, matching the cursor + page-token
 * semantics already shared by `referencePullQuery`. `outletId` scopes
 * the bucket; an outlet that does not belong to the caller's merchant
 * returns an empty bucket, indistinguishable from a genuinely empty
 * outlet — same tenancy model as `GET /v1/sales`.
 */
export const stockLedgerPullQuery = z
  .object({
    outletId: uuidV7Typed,
    updatedAfter: isoTimestamp.optional(),
    pageToken: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
export type StockLedgerPullQuery = z.infer<typeof stockLedgerPullQuery>;

export const stockLedgerPullResponse = envelope(stockLedgerEntry);
export type StockLedgerPullResponse = z.infer<typeof stockLedgerPullResponse>;
