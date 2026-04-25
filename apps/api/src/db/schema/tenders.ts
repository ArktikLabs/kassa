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
 *
 * `buyer_ref_last4` is the static-QRIS clerk-entered last-4-digits of the
 * buyer's transfer reference. EOD reconciliation (KASA-64) uses it together
 * with `amount_idr`, the sale's outlet, and a ±10-min window around the
 * Midtrans `settlement_time` to match unverified static-QRIS tenders against
 * the settlement report. NULL on cash and dynamic-QRIS tenders.
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
    buyerRefLast4: text("buyer_ref_last4"),
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
    // Reconciliation lookup: pull every unverified static-QRIS tender for an
    // outlet on a business date. Partial so the index doesn't carry the
    // verified rows we never replay.
    staticQrisUnverifiedIdx: index("tenders_static_qris_unverified_idx")
      .on(table.method, table.verified, table.amountIdr)
      .where(sql`method = 'qris_static' AND verified = false`),
  }),
);

export type Tender = typeof tenders.$inferSelect;
export type NewTender = typeof tenders.$inferInsert;
