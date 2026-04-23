import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";

/**
 * Single-use 8-character codes issued by staff (`POST /v1/auth/enrolment-codes`)
 * and consumed once by a device (`POST /v1/auth/enroll`). The `code` is the
 * primary key — it is generated from a small unambiguous alphabet so a cashier
 * can read it off the screen and type it on a tablet.
 */
export const enrolmentCodes = pgTable("enrolment_codes", {
  code: text("code").primaryKey(),
  outletId: uuid("outlet_id").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedByDeviceId: uuid("consumed_by_device_id").references(() => devices.id),
});

export type EnrolmentCode = typeof enrolmentCodes.$inferSelect;
export type NewEnrolmentCode = typeof enrolmentCodes.$inferInsert;
