import { z } from "zod";
import { itemAvailability } from "./sync.js";

const uuidV7 = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });
const rupiahInteger = z.number().int().nonnegative().max(9_007_199_254_740_991);

const itemCode = z.string().trim().min(1).max(64);
const itemName = z.string().trim().min(1).max(256);

/**
 * Shape accepted by `POST /v1/catalog/items`. The server assigns `id` (uuidv7)
 * and the `merchantId` is derived from the staff principal's `X-Staff-Merchant-Id`.
 * `isStockTracked` and `isActive` mirror the schema defaults so omitting them
 * means "active, tracked" (ARCHITECTURE.md §3.2).
 */
export const itemCreateRequest = z
  .object({
    code: itemCode,
    name: itemName,
    priceIdr: rupiahInteger,
    uomId: uuidV7,
    bomId: uuidV7.nullable().optional(),
    isStockTracked: z.boolean().optional(),
    /**
     * KASA-218 — Indonesian PPN rate as integer percent (0..100). Optional;
     * omitting it accepts the schema default (11, the statutory rate). Pre-
     * KASA-218 back-office callers that don't yet send the field land on
     * the same default with no behaviour change.
     */
    taxRate: z.number().int().min(0).max(100).optional(),
    /**
     * KASA-248 — mid-shift availability flag. Optional on create; omitting
     * means `available`. Owner/manager-only writes via PATCH are the primary
     * path; create-time is included so seed scripts can land items with a
     * pre-set state.
     */
    availability: itemAvailability.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type ItemCreateRequest = z.infer<typeof itemCreateRequest>;

/**
 * Shape accepted by `PATCH /v1/catalog/items/:itemId`. All fields optional;
 * an empty body is rejected (nothing-to-do is a client error).
 */
export const itemUpdateRequest = z
  .object({
    code: itemCode.optional(),
    name: itemName.optional(),
    priceIdr: rupiahInteger.optional(),
    uomId: uuidV7.optional(),
    bomId: uuidV7.nullable().optional(),
    isStockTracked: z.boolean().optional(),
    /** KASA-218 — Indonesian PPN rate as integer percent (0..100). */
    taxRate: z.number().int().min(0).max(100).optional(),
    /**
     * KASA-248 — mid-shift availability flag. The POS catalog tile's long-press
     * "Tandai sebagai habis" sheet PATCHes this field; the server stores it
     * and echoes it back in the items sync stream so other devices grey out
     * the same tile within one sync cycle.
     */
    availability: itemAvailability.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be present.",
  });
export type ItemUpdateRequest = z.infer<typeof itemUpdateRequest>;

/**
 * Query shape for `GET /v1/catalog/items`. `updatedAfter` is the cursor from
 * the previous response (`nextCursor`); `pageToken` is the opaque within-window
 * page key (`nextPageToken`). `limit` is clamped server-side.
 */
export const itemListQuery = z
  .object({
    updatedAfter: isoTimestamp.optional(),
    pageToken: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ItemListQuery = z.infer<typeof itemListQuery>;

/**
 * Single-item response shape. Matches `itemRecord` from `./sync.ts` — kept as
 * a separate alias so the CRUD response can evolve independently of the
 * delta-pull envelope if the two ever diverge.
 */
export { itemRecord as itemResponse, type ItemRecord as ItemResponse } from "./sync.js";
