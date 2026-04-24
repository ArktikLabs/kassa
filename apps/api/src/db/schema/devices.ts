import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { merchants } from "./merchants.js";
import { outlets } from "./outlets.js";

export const deviceStatusValues = ["pending", "active", "revoked"] as const;
export type DeviceStatus = (typeof deviceStatusValues)[number];

/**
 * One row per enrolled tablet. `api_key_hash` stores `argon2id(api_secret)`;
 * the plaintext `api_secret` is returned to the client exactly once, on a
 * successful `POST /v1/auth/enroll`, and the public `api_key` returned
 * alongside it is a URL-safe encoding of `id` used as the auth username on
 * subsequent requests (ARCHITECTURE.md §4 "Authentication").
 *
 * `fingerprint` persists the `deviceFingerprint` field the POS sends on enrol
 * so ops can correlate with audit logs without re-reading them; it is not
 * considered a security boundary (KASA-53 hand-off note §3).
 *
 * `merchant_id` is denormalised from the outlet for tenant-scoped queries
 * (ARCHITECTURE.md §2.2 "Strict rules for the API").
 */
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    apiKeyHash: text("api_key_hash").notNull(),
    fingerprint: text("fingerprint"),
    status: text("status", { enum: deviceStatusValues }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => ({
    merchantIdx: index("devices_merchant_idx").on(table.merchantId),
    outletIdx: index("devices_outlet_idx").on(table.outletId),
  }),
);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
