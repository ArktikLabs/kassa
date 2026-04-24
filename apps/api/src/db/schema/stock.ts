import { index, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, updatedAtCol } from "./shared.js";
import { items } from "./items.js";
import { outlets } from "./outlets.js";

export const stockLedgerReasonValues = [
  "sale",
  "sale_void",
  "refund",
  "receipt",
  "adjustment",
  "transfer_in",
  "transfer_out",
  "reconcile",
] as const;
export type StockLedgerReason = (typeof stockLedgerReasonValues)[number];

/**
 * Per-outlet on-hand quantity, one row per `(outlet_id, item_id)`. Derived
 * from `stock_ledger` (ARCHITECTURE.md §3.2 "Stock truth" — ledger is
 * authoritative, snapshot is a projection rebuilt by a BullMQ job and on
 * demand after a sale commit).
 */
export const stockSnapshots = pgTable(
  "stock_snapshots",
  {
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    onHand: numeric("on_hand", { precision: 18, scale: 6 }).notNull().default("0"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.outletId, table.itemId] }),
    // Delta-pull index for the per-outlet stock cursor (ARCHITECTURE.md §3.1).
    outletUpdatedAtIdx: index("stock_snapshots_outlet_updated_at_idx").on(
      table.outletId,
      table.updatedAt,
    ),
  }),
);

export type StockSnapshot = typeof stockSnapshots.$inferSelect;
export type NewStockSnapshot = typeof stockSnapshots.$inferInsert;

/**
 * Append-only stock movement log. Every ledger write carries a reason and an
 * optional `(ref_type, ref_id)` link back to the originating row — a sale,
 * refund, adjustment note, etc. Stock snapshots are rebuildable from this
 * table alone; under a reconcile job we truncate and re-aggregate.
 *
 * `delta` is signed: sales and voids are negative, receipts and adjustments
 * are positive.
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: uuid("id").primaryKey(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    delta: numeric("delta", { precision: 18, scale: 6 }).notNull(),
    reason: text("reason", { enum: stockLedgerReasonValues }).notNull(),
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    outletItemCreatedIdx: index("stock_ledger_outlet_item_created_idx").on(
      table.outletId,
      table.itemId,
      table.createdAt,
    ),
    refIdx: index("stock_ledger_ref_idx").on(table.refType, table.refId),
  }),
);

export type StockLedgerRow = typeof stockLedger.$inferSelect;
export type NewStockLedgerRow = typeof stockLedger.$inferInsert;
