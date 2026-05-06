import { z } from "zod";

/*
 * Merchant settings — KASA-219. The owner edits these in the back-office;
 * the POS pulls them via `GET /v1/merchant/me` so every printed/PDF receipt
 * carries the merchant identity (display name, address, phone, optional
 * NPWP) and a customisable footer message. All fields except `displayName`
 * are optional so a merchant can ship the v0 layout with whatever subset
 * they have on hand.
 *
 * Limits chosen to fit a 32-column ESC/POS line after centering and to keep
 * the PDF header on one row at A4 portrait. NPWP is the 16-digit Indonesian
 * tax id (post-2022 format); we don't accept the legacy 15-digit form.
 */

const uuidV7 = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });

const trim = (max: number) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().max(max));

/**
 * Merchant-wide receipt branding. `displayName` is the centered receipt
 * header and is required (server-seeded from the merchant row's `name` at
 * first read so a brand-new merchant still prints a header). The other
 * fields print only when set. NPWP must be exactly 16 digits.
 */
export const merchantSettings = z
  .object({
    displayName: trim(80).pipe(z.string().min(1)),
    addressLine: trim(160).nullable(),
    phone: z
      .string()
      .max(32)
      .regex(/^[\d+\-\s()]+$/, "phone may only contain digits, spaces, + - or ( )")
      .nullable(),
    npwp: z
      .string()
      .regex(/^\d{16}$/, "NPWP must be exactly 16 digits")
      .nullable(),
    receiptFooterText: trim(140).nullable(),
  })
  .strict();
export type MerchantSettings = z.infer<typeof merchantSettings>;

/**
 * `GET /v1/merchant/me` response. Identity (id) + the editable settings +
 * the row's `updatedAt` so a sync runner can window the read-through cache.
 */
export const merchantMeResponse = z
  .object({
    id: uuidV7,
    settings: merchantSettings,
    updatedAt: isoTimestamp,
  })
  .strict();
export type MerchantMeResponse = z.infer<typeof merchantMeResponse>;

/**
 * `PATCH /v1/merchant` request — partial, owner role only. The server
 * preserves any field the client omits. `displayName` cannot be cleared
 * once set; everything else accepts `null` to clear.
 */
export const merchantSettingsUpdateRequest = z
  .object({
    displayName: trim(80).pipe(z.string().min(1)).optional(),
    addressLine: trim(160).nullable().optional(),
    phone: z
      .string()
      .max(32)
      .regex(/^[\d+\-\s()]+$/, "phone may only contain digits, spaces, + - or ( )")
      .nullable()
      .optional(),
    npwp: z
      .string()
      .regex(/^\d{16}$/, "NPWP must be exactly 16 digits")
      .nullable()
      .optional(),
    receiptFooterText: trim(140).nullable().optional(),
  })
  .strict();
export type MerchantSettingsUpdateRequest = z.infer<typeof merchantSettingsUpdateRequest>;
