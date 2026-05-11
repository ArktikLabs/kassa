import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { boms } from "./boms.js";
import { createdAtCol, rupiah, updatedAtCol } from "./shared.js";
import { items } from "./items.js";
import { merchants } from "./merchants.js";
import { outlets } from "./outlets.js";
import { staff } from "./staff.js";
import { uoms } from "./uoms.js";

export const saleStatusValues = ["open", "finalised", "voided", "refunded"] as const;
export type SaleStatus = (typeof saleStatusValues)[number];

/**
 * Sale header.
 *
 * `local_sale_id` is the client-generated UUIDv7 used for idempotency on
 * `POST /v1/sales` / `POST /v1/sales/sync` (ARCHITECTURE.md §3.1 "Idempotency
 * key"). The unique index on `(merchant_id, local_sale_id)` is what collapses
 * duplicate pushes into a single server row; we key by merchant, not outlet,
 * so the invariant still holds even if the PWA is re-enrolled at a different
 * outlet between retries.
 *
 * `business_date` is the outlet's local calendar date (Asia/Jakarta, UTC+7)
 * computed at sale time by the client and stored unmodified; reconciliation
 * and EOD queries pivot on this field, not on `created_at` (ARCHITECTURE.md
 * §3.2 "Time").
 */
export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    clerkId: uuid("clerk_id")
      .notNull()
      .references(() => staff.id),
    localSaleId: uuid("local_sale_id").notNull(),
    businessDate: date("business_date").notNull(),
    status: text("status", { enum: saleStatusValues }).notNull().default("finalised"),
    subtotalIdr: rupiah("subtotal_idr").notNull(),
    discountIdr: rupiah("discount_idr").notNull().default(0),
    totalIdr: rupiah("total_idr").notNull(),
    /**
     * KASA-218 — Indonesian PPN (VAT) component of this sale. Server-derived
     * at submit from per-line `item.tax_rate` and the merchant's
     * `tax_inclusive` flag, persisted so EOD reports can sum it without
     * re-pricing. For an inclusive merchant the amount is embedded inside
     * `subtotal_idr` / `total_idr`; for an exclusive merchant it sits on top
     * (`total_idr = subtotal_idr − discount_idr + tax_idr`). Default 0 so
     * pre-KASA-218 rows stay numerically valid.
     */
    taxIdr: rupiah("tax_idr").notNull().default(0),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    /**
     * KASA-236-A — business date the void counts against in EOD variance.
     * The original sale stays on `business_date`; voids may straddle a day
     * boundary (e.g. a 23:55 sale voided at 00:05) so the void owns its own
     * date, written by the POS at void time.
     */
    voidBusinessDate: date("void_business_date"),
    voidReason: text("void_reason"),
    /**
     * KASA-236-A — client-generated UUIDv7 idempotency key for the void
     * event. Paired with `merchant_id` in `sales_merchant_local_void_id_uniq`
     * so a retried void push collapses to the same row instead of producing
     * a double-balanced ledger.
     */
    localVoidId: uuid("local_void_id"),
    voidedByStaffId: uuid("voided_by_staff_id").references(() => staff.id),
    /**
     * KASA-151 — set when the row originated from the KASA-71 production
     * uptime probe (see `synthetic` tender method). EOD close excludes
     * `synthetic = true` rows from breakdown / expected-cash / variance and
     * writes balancing `synthetic_eod_reconcile` ledger entries so per-item
     * stock nets to zero. Default `false` — every existing and merchant-
     * facing sale is non-synthetic.
     */
    synthetic: boolean("synthetic").notNull().default(false),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    // Idempotency — the single most important index in the schema.
    merchantLocalSaleIdUniq: uniqueIndex("sales_merchant_local_sale_id_uniq").on(
      table.merchantId,
      table.localSaleId,
    ),
    // KASA-236-A — void idempotency key. Partial-unique on (merchant_id,
    // local_void_id) where `local_void_id IS NOT NULL` so unvoided sales
    // don't collide on the null sentinel.
    merchantLocalVoidIdUniq: uniqueIndex("sales_merchant_local_void_id_uniq")
      .on(table.merchantId, table.localVoidId)
      .where(sql`${table.localVoidId} IS NOT NULL`),
    // EOD query path: sum tenders by outlet + business_date.
    outletBusinessDateIdx: index("sales_outlet_business_date_idx").on(
      table.outletId,
      table.businessDate,
    ),
    merchantCreatedAtIdx: index("sales_merchant_created_at_idx").on(
      table.merchantId,
      table.createdAt,
    ),
  }),
);

export type Sale = typeof sales.$inferSelect;
export type NewSale = typeof sales.$inferInsert;

/**
 * Sale line item. A line can optionally reference the BOM used to ring it up
 * (`bom_id`) so later inspection / reporting can tell whether the line fired
 * a stock ledger explosion.
 *
 * `line_total_idr` = `unit_price_idr * quantity + modifier deltas − line
 * discount`, materialised at write time so the summary shape on the wire is
 * not recomputed on read.
 */
export const saleItems = pgTable(
  "sale_items",
  {
    id: uuid("id").primaryKey(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    uomId: uuid("uom_id")
      .notNull()
      .references(() => uoms.id),
    bomId: uuid("bom_id").references(() => boms.id),
    quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
    unitPriceIdr: rupiah("unit_price_idr").notNull(),
    lineTotalIdr: rupiah("line_total_idr").notNull(),
    isStockAffecting: boolean("is_stock_affecting").notNull().default(true),
    createdAt: createdAtCol(),
  },
  (table) => ({
    saleIdx: index("sale_items_sale_idx").on(table.saleId),
    itemIdx: index("sale_items_item_idx").on(table.itemId),
  }),
);

export type SaleItem = typeof saleItems.$inferSelect;
export type NewSaleItem = typeof saleItems.$inferInsert;
