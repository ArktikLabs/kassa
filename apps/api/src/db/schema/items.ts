import { boolean, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
