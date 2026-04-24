import { pgTable, text, uuid } from "drizzle-orm/pg-core";
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
  createdAt: createdAtCol(),
  updatedAt: updatedAtCol(),
});

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
