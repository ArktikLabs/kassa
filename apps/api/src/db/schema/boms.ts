import { index, numeric, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, updatedAtCol } from "./shared.js";
import { items } from "./items.js";
import { merchants } from "./merchants.js";
import { uoms } from "./uoms.js";

/**
 * Recipe header. One BOM belongs to a single merchant; an item references a
 * BOM by id (`items.bom_id`), and the BOM's `item_id` points back at the menu
 * item for convenience. The bidirectional link is redundant in the data layer
 * but cheap (one uuid) and makes both directions of traversal a zero-join
 * lookup.
 */
export const boms = pgTable(
  "boms",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    merchantUpdatedAtIdx: index("boms_merchant_updated_at_idx").on(
      table.merchantId,
      table.updatedAt,
    ),
    merchantItemIdx: index("boms_merchant_item_idx").on(table.merchantId, table.itemId),
  }),
);

export type Bom = typeof boms.$inferSelect;
export type NewBom = typeof boms.$inferInsert;

/**
 * Recipe line. Composite PK `(bom_id, component_item_id)` — a single component
 * cannot appear twice in the same BOM; if a recipe needs 2g + 3g of the same
 * ingredient, that is modelled as a single 5g row.
 *
 * `quantity` is `numeric(18,6)` so stock units smaller than one gram / millilitre
 * are representable without float drift (stock is not money and so is allowed
 * a fractional unit).
 */
export const bomComponents = pgTable(
  "bom_components",
  {
    bomId: uuid("bom_id")
      .notNull()
      .references(() => boms.id, { onDelete: "cascade" }),
    componentItemId: uuid("component_item_id")
      .notNull()
      .references(() => items.id),
    quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
    uomId: uuid("uom_id")
      .notNull()
      .references(() => uoms.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bomId, table.componentItemId] }),
    bomIdx: index("bom_components_bom_idx").on(table.bomId),
  }),
);

export type BomComponent = typeof bomComponents.$inferSelect;
export type NewBomComponent = typeof bomComponents.$inferInsert;
