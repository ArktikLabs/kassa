import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, updatedAtCol } from "./shared.js";
import { merchants } from "./merchants.js";

/**
 * Units of measure (pcs, gram, ml, …). Reference data; mutated rarely but
 * never seeded globally — each merchant owns their own table so we never
 * touch another tenant's rows.
 */
export const uoms = pgTable(
  "uoms",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    merchantCodeUnique: uniqueIndex("uoms_merchant_code_uniq").on(table.merchantId, table.code),
    merchantUpdatedAtIdx: index("uoms_merchant_updated_at_idx").on(
      table.merchantId,
      table.updatedAt,
    ),
  }),
);

export type Uom = typeof uoms.$inferSelect;
export type NewUom = typeof uoms.$inferInsert;
