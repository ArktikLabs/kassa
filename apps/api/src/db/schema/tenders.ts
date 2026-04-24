import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, rupiah, updatedAtCol } from "./shared.js";
import { sales } from "./sales.js";

export const tenderMethodValues = ["cash", "qris_dynamic", "qris_static"] as const;
export type TenderMethod = (typeof tenderMethodValues)[number];

export const tenderStatusValues = ["pending", "paid", "failed", "expired", "cancelled"] as const;
export type TenderStatus = (typeof tenderStatusValues)[number];

/**
 * Payment instrument applied to a sale. A single sale can have multiple
 * tenders (cash + QRIS split). `order_ref` is the Midtrans order id for QRIS
 * tenders, NULL for cash.
 *
 * `verified` is the server's confirmation that the money actually moved —
 * `true` only after cash count-in, the Midtrans webhook for dynamic QRIS, or
 * the EOD reconciliation pass for static QRIS.
 */
export const tenders = pgTable(
  "tenders",
  {
    id: uuid("id").primaryKey(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    method: text("method", { enum: tenderMethodValues }).notNull(),
    status: text("status", { enum: tenderStatusValues }).notNull().default("pending"),
    amountIdr: rupiah("amount_idr").notNull(),
    orderRef: text("order_ref"),
    verified: boolean("verified").notNull().default(false),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    saleIdx: index("tenders_sale_idx").on(table.saleId),
    // Webhook lookup: find the tender by Midtrans order_id. Partial so cash
    // tenders (NULL order_ref) do not collide.
    orderRefUniq: uniqueIndex("tenders_order_ref_uniq")
      .on(table.orderRef)
      .where(sql`order_ref IS NOT NULL`),
  }),
);

export type Tender = typeof tenders.$inferSelect;
export type NewTender = typeof tenders.$inferInsert;
