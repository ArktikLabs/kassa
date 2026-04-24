import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, updatedAtCol } from "./shared.js";
import { merchants } from "./merchants.js";

export const staffRoleValues = ["owner", "manager", "cashier", "read_only"] as const;
export type StaffRole = (typeof staffRoleValues)[number];

/**
 * Back-office / POS staff. `password_hash` is `argon2id` per
 * ARCHITECTURE.md §4 "Authentication"; `pin_hash` is the short lock-screen PIN
 * that re-verifies the session on the POS after 5 min of inactivity — it is
 * also Argon2id-hashed and, crucially, is **not** a substitute for the primary
 * credential (session cookies are still the auth layer).
 */
export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: staffRoleValues }).notNull(),
    pinHash: text("pin_hash"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (table) => ({
    emailUnique: uniqueIndex("staff_merchant_email_uniq").on(table.merchantId, table.email),
    merchantIdx: index("staff_merchant_idx").on(table.merchantId),
  }),
);

export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;
