import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Brute-force / credential-stuffing audit table for
 * `POST /v1/auth/session/login` (KASA-312). One row per attempt.
 *
 * Both `account_id_hash` and `ip_hash` are HMAC-SHA256 over the normalized
 * email / IP keyed by `LOGIN_ATTEMPT_HMAC_SECRET` — the plaintext never
 * touches the row so an exposed backup is GDPR-/PDPA-safe even if the
 * HMAC secret is also leaked (the digest is still not directly reversible
 * to the original address). Pair with the 30-day TTL cleanup query in
 * `services/login-attempts/service.ts` so the table doesn't grow forever.
 */
export const authLoginAttempts = pgTable(
  "auth_login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountIdHash: text("account_id_hash").notNull(),
    ipHash: text("ip_hash").notNull(),
    success: boolean("success").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Lockout policy reads `(account_id_hash, attempted_at)` ordered
    // newest-first to walk back from the last success — composite index
    // keeps it a single bitmap scan.
    accountAttemptedIdx: index("auth_login_attempts_account_attempted_idx").on(
      table.accountIdHash,
      table.attemptedAt,
    ),
    // The 30-day cleanup sweeps by `attempted_at` only; a standalone btree
    // beats the composite when most accounts have few rows.
    attemptedAtIdx: index("auth_login_attempts_attempted_at_idx").on(table.attemptedAt),
  }),
);

export type AuthLoginAttempt = typeof authLoginAttempts.$inferSelect;
export type NewAuthLoginAttempt = typeof authLoginAttempts.$inferInsert;
