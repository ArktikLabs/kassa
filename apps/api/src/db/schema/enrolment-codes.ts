import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";
import { merchants } from "./merchants.js";
import { outlets } from "./outlets.js";
import { staff } from "./staff.js";

/**
 * Single-use 8-character codes issued by staff (`POST /v1/auth/enrolment-codes`)
 * and consumed once by a device (`POST /v1/auth/enroll`). The `code` is the
 * primary key — it is generated from a small unambiguous alphabet so a cashier
 * can read it off the screen and type it on a tablet. A collision on insert is
 * surfaced as Postgres SQLSTATE `23505` and the enrolment service retries with
 * a fresh code (KASA-53 hand-off note §1).
 *
 * `merchant_id` is denormalised from the outlet so the ops "recent enrolments
 * for merchant X" view does not join across outlets.
 */
export const enrolmentCodes = pgTable(
  "enrolment_codes",
  {
    code: text("code").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => staff.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByDeviceId: uuid("consumed_by_device_id").references(() => devices.id),
  },
  (table) => ({
    outletIdx: index("enrolment_codes_outlet_idx").on(table.outletId),
    // Ops sweeper: find unconsumed codes approaching expiry.
    unconsumedExpiryIdx: index("enrolment_codes_unconsumed_expiry_idx").on(table.expiresAt),
  }),
);

export type EnrolmentCode = typeof enrolmentCodes.$inferSelect;
export type NewEnrolmentCode = typeof enrolmentCodes.$inferInsert;
