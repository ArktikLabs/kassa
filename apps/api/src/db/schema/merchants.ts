import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, updatedAtCol } from "./shared.js";

/**
 * Top of the tenant hierarchy. Every other row in the v0 model carries a
 * `merchant_id` (either directly or transitively through `outlet_id`) so the
 * per-request tenant-scope preHandler can enforce isolation (ARCHITECTURE.md
 * §2.2 "Strict rules for the API").
 */
export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  /**
   * KASA-218 — pricing convention for Indonesian PPN (VAT). When true (the
   * default for Indonesian merchants), `items.price_idr` is treated as
   * tax-inclusive on submit: the server reverse-derives `sales.tax_idr` from
   * the line totals (`round(lineTotal − lineTotal/(1 + taxRate/100))`) and
   * the printed receipt shows "PPN sudah termasuk". When false, tax is added
   * on top of the catalog price and `sales.total_idr` includes it explicitly.
   */
  taxInclusive: boolean("tax_inclusive").notNull().default(true),
  createdAt: createdAtCol(),
  updatedAt: updatedAtCol(),
});

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
