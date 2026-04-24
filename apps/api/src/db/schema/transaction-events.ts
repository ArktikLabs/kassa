import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { merchants } from "./merchants.js";
import { outlets } from "./outlets.js";
import { rupiah } from "./shared.js";
import { sales } from "./sales.js";
import { tenders } from "./tenders.js";

export const transactionEventKindValues = [
  "sale.finalised",
  "sale.voided",
  "sale.refunded",
  "tender.paid",
  "tender.failed",
  "tender.refunded",
] as const;
export type TransactionEventKind = (typeof transactionEventKindValues)[number];

/**
 * Append-only money-movement log. Summary rows (`sales`, `tenders`,
 * `end_of_day`) are the ergonomic read layer; this table is the auditable
 * ledger of every event that moved rupiah. `amount_idr` is signed — a void
 * is the negative of the original sale total.
 *
 * ARCHITECTURE.md §3.2 calls this out as the reconstruction source of truth:
 * the summary rows above are derivable from this log. Nothing here is ever
 * updated or deleted.
 */
export const transactionEvents = pgTable(
  "transaction_events",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    outletId: uuid("outlet_id").references(() => outlets.id),
    saleId: uuid("sale_id").references(() => sales.id),
    tenderId: uuid("tender_id").references(() => tenders.id),
    kind: text("kind", { enum: transactionEventKindValues }).notNull(),
    amountIdr: rupiah("amount_idr").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    merchantCreatedAtIdx: index("transaction_events_merchant_created_at_idx").on(
      table.merchantId,
      table.createdAt,
    ),
    saleIdx: index("transaction_events_sale_idx").on(table.saleId),
    tenderIdx: index("transaction_events_tender_idx").on(table.tenderId),
  }),
);

export type TransactionEvent = typeof transactionEvents.$inferSelect;
export type NewTransactionEvent = typeof transactionEvents.$inferInsert;
