import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, updatedAtCol } from "./shared.js";
import { merchants } from "./merchants.js";

/**
 * A physical location under a merchant — one shop, one till. Owns its stock
 * snapshot, its sales, and its end-of-day records.
 *
 * `code` is a short merchant-scoped identifier (e.g. "WRG-01") shown on
 * receipts; `name` is the human-facing name. Both are mutable, so neither is a
 * primary key.
 */
export const outlets = pgTable(
  "outlets",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("Asia/Jakarta"),
    /*
     * KASA-367 — per-outlet receipt branding. All optional; an outlet
     * without overrides falls back to merchant-wide branding (KASA-219)
     * and the legacy outlet-name-only header. `taxId` is the bare digit
     * NPWP (15 or 16 digits) — the POS receipt template formats with
     * the canonical `00.000.000.0-000.000` mask.
     */
    displayName: text("display_name"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    taxId: text("tax_id"),
    receiptFooterLine1: text("receipt_footer_line1"),
    receiptFooterLine2: text("receipt_footer_line2"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    merchantCodeUnique: uniqueIndex("outlets_merchant_code_uniq").on(table.merchantId, table.code),
    // Delta-pull index (ARCHITECTURE.md §3.1 Flow A).
    merchantUpdatedAtIdx: index("outlets_merchant_updated_at_idx").on(
      table.merchantId,
      table.updatedAt,
    ),
  }),
);

export type Outlet = typeof outlets.$inferSelect;
export type NewOutlet = typeof outlets.$inferInsert;
