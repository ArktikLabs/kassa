import { boolean, integer, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, rupiah, updatedAtCol } from "./shared.js";
import { merchants } from "./merchants.js";
import { uoms } from "./uoms.js";

/**
 * Catalog row. `price_idr` is integer rupiah at rest (ARCHITECTURE.md §3.2
 * "Money"). `is_stock_tracked` gates stock ledger writes on sale finalise —
 * untracked items (e.g. a generic "misc. 10k" line) do not decrement stock.
 *
 * `bom_id` is nullable: a plain item has no recipe; a menu item with a BOM
 * points at it so sale finalise can explode the components and write ledger
 * deltas per component instead of the menu row (ARCHITECTURE.md §3.1 Flow B).
 * The FK is deferred — we set it in `boms.ts` to avoid a circular import, and
 * it is validated at query time by a join, not a constraint, in v0.
 */
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    priceIdr: rupiah("price_idr").notNull(),
    uomId: uuid("uom_id")
      .notNull()
      .references(() => uoms.id),
    bomId: uuid("bom_id"),
    isStockTracked: boolean("is_stock_tracked").notNull().default(true),
    /**
     * When false (the default), `sale.submit` refuses lines that would take
     * `on_hand` below zero. Flipped to true for raw materials whose inventory
     * is managed outside the system (ARCHITECTURE.md ADR-006, KASA-66 AC).
     */
    allowNegative: boolean("allow_negative").notNull().default(false),
    /**
     * KASA-218 — Indonesian PPN (VAT) rate as integer percent (0..100).
     * Default 11 matches the current statutory rate. Combined with the
     * merchant-level `tax_inclusive` flag at sale-submit time to derive
     * `sales.tax_idr` (per-line then summed). v0 supports a single rate per
     * item; multi-rate (food vs service vs alcohol) is explicitly out of
     * scope per KASA-218.
     */
    taxRate: integer("tax_rate").notNull().default(11),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    merchantCodeUnique: uniqueIndex("items_merchant_code_uniq").on(table.merchantId, table.code),
    merchantUpdatedAtIdx: index("items_merchant_updated_at_idx").on(
      table.merchantId,
      table.updatedAt,
    ),
  }),
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
