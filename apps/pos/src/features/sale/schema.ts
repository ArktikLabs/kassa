import { z } from "zod";

/*
 * Client-side canonical sale payload. The Zod schema is the contract between
 * the UI (which builds the object from cart + tender inputs) and the Dexie
 * outbox (which stores the object for BackgroundSync to push). Per
 * ARCHITECTURE.md §3.2, the server applies the same validation on the write
 * path and keys idempotency on (merchantId, localSaleId).
 *
 * Shapes match `PendingSale` in data/db/types.ts, but this is the canonical
 * source of truth for the wire/finalize layer — the Dexie row type is derived
 * from a successful parse.
 */

export const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuidV7 = z.string().regex(UUID_V7_REGEX, "must be a UUIDv7");
const rupiah = z.number().int().nonnegative();

/*
 * `YYYY-MM-DD`. Merchant-local business date, not UTC — clerks close the day on
 * the outlet's clock. The sync engine sends this through untouched so the
 * server can bucket revenue without round-tripping timezone state.
 */
export const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const kassaSaleItem = z
  .object({
    itemId: uuidV7,
    bomId: uuidV7.nullable(),
    quantity: z.number().positive(),
    uomId: uuidV7,
    unitPriceIdr: rupiah,
    lineTotalIdr: rupiah,
  })
  .strict();
export type KassaSaleItem = z.infer<typeof kassaSaleItem>;

export const kassaSaleTender = z
  .object({
    method: z.enum(["cash", "qris", "card", "other"]),
    amountIdr: rupiah,
    reference: z.string().nullable(),
  })
  .strict();
export type KassaSaleTender = z.infer<typeof kassaSaleTender>;

export const kassaSale = z
  .object({
    localSaleId: uuidV7,
    outletId: uuidV7,
    clerkId: z.string().min(1),
    businessDate,
    /** RFC 3339 timestamp with explicit offset — the finalize clock, not the server's. */
    createdAt: z.string().datetime({ offset: true }),
    subtotalIdr: rupiah,
    discountIdr: rupiah,
    totalIdr: rupiah,
    items: z.array(kassaSaleItem).min(1),
    tenders: z.array(kassaSaleTender).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const tendered = value.tenders.reduce((acc, t) => acc + t.amountIdr, 0);
    if (tendered < value.totalIdr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tenders"],
        message: "tenders total must cover the sale total",
      });
    }
    const subtotal = value.items.reduce((acc, i) => acc + i.lineTotalIdr, 0);
    if (subtotal !== value.subtotalIdr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtotalIdr"],
        message: "subtotal must equal the sum of line totals",
      });
    }
    if (value.subtotalIdr - value.discountIdr !== value.totalIdr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalIdr"],
        message: "total must equal subtotal minus discount",
      });
    }
  });
export type KassaSale = z.infer<typeof kassaSale>;
