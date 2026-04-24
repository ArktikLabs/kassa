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
