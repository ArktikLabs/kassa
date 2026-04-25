import { z } from "zod";

/*
 * Wire schemas for the QRIS tender side-channel (ARCHITECTURE.md §3.1 Flow C).
 *
 * The POS creates a dynamic QRIS order at tender time, renders `qrString` to
 * the customer's phone, and polls `qrisOrderId` until Midtrans confirms a
 * `paid` state. The `qrisOrderId` is the merchant-side order id Midtrans
 * uses as both the POST parameter and the webhook identifier — we key it off
 * the PWA's `localSaleId` so every tender row reconciles 1:1 against the
 * outbox row without a joining table.
 */

// Match the strict UUIDv7 validator used by the POS finalize schema
// (`apps/pos/src/features/sale/schema.ts`). The Midtrans `order_id` we send
// equals the POS `localSaleId`, so accepting any UUID version here would
// silently let other UUID flavours through and break the 1:1 mapping
// between the outbox row and the webhook callback.
const uuidV7 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "must be a UUIDv7",
  );
const rupiahInteger = z.number().int().positive();

export const QRIS_ORDER_STATUSES = ["pending", "paid", "expired", "cancelled", "failed"] as const;

export const qrisOrderStatus = z.enum(QRIS_ORDER_STATUSES);
export type QrisOrderStatus = z.infer<typeof qrisOrderStatus>;

export const qrisCreateOrderRequest = z
  .object({
    amount: rupiahInteger,
    localSaleId: uuidV7,
    outletId: uuidV7,
    /**
     * Optional QR lifetime in whole minutes. Plumbed into Midtrans
     * `custom_expiry` by the provider (KASA-85). Omit to accept the Midtrans
     * default (15 minutes as of April 2026).
     */
    expiryMinutes: z.number().int().positive().optional(),
  })
  .strict();
export type QrisCreateOrderRequest = z.infer<typeof qrisCreateOrderRequest>;

export const qrisCreateOrderResponse = z
  .object({
    qrisOrderId: z.string().min(1),
    qrString: z.string().min(1),
    /** ISO-8601 with an explicit offset if Midtrans returned one. */
    expiresAt: z.string().min(1).nullable(),
  })
  .strict();
export type QrisCreateOrderResponse = z.infer<typeof qrisCreateOrderResponse>;

export const qrisOrderStatusResponse = z
  .object({
    qrisOrderId: z.string().min(1),
    status: qrisOrderStatus,
    grossAmount: rupiahInteger,
    paidAt: z.string().min(1).nullable(),
  })
  .strict();
export type QrisOrderStatusResponse = z.infer<typeof qrisOrderStatusResponse>;
