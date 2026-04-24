import { boolean, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, rupiah, updatedAtCol } from "./shared.js";
import { merchants } from "./merchants.js";

/**
 * Item options / add-ons (size, syrup, spice level, …). `price_delta_idr` is
 * the rupiah adjustment applied to the owning sale line when selected; negative
 * values are allowed (e.g. "less sugar −500").
 */
export const modifiers = pgTable(
  "modifiers",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    priceDeltaIdr: rupiah("price_delta_idr").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    merchantCodeUnique: uniqueIndex("modifiers_merchant_code_uniq").on(
      table.merchantId,
      table.code,
    ),
    merchantUpdatedAtIdx: index("modifiers_merchant_updated_at_idx").on(
      table.merchantId,
      table.updatedAt,
    ),
  }),
);

export type Modifier = typeof modifiers.$inferSelect;
export type NewModifier = typeof modifiers.$inferInsert;
