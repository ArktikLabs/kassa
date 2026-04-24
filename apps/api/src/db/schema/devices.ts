import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const deviceStatusValues = ["pending", "active", "revoked"] as const;
export type DeviceStatus = (typeof deviceStatusValues)[number];

/**
 * `api_key_hash` stores `argon2id(api_secret)`. The plaintext `api_secret` is returned
 * to the client exactly once, on a successful `POST /v1/auth/enroll`. The public
 * `api_key` returned alongside it is a URL-safe encoding of `id` and is used by the
 * device as the auth username when subsequent endpoints land in KASA-25.
 */
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  outletId: uuid("outlet_id").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  status: text("status", { enum: deviceStatusValues }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
