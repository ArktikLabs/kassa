import { desc, eq, lt } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { authLoginAttempts } from "../../db/schema/login-attempts.js";
import type {
  AccountAttemptSummary,
  LoginAttemptsRepository,
  RecordedLoginAttempt,
} from "./repository.js";

/**
 * Drizzle-backed `auth_login_attempts` (KASA-312). The summarize query
 * scans newest-first along the `(account_id_hash, attempted_at)`
 * composite index until it hits the first success, so the cost is
 * proportional to the size of the active lockout window — not the total
 * row count.
 */
export class PgLoginAttemptsRepository implements LoginAttemptsRepository {
  constructor(private readonly db: Database) {}

  async record(attempt: RecordedLoginAttempt): Promise<void> {
    await this.db.insert(authLoginAttempts).values({
      accountIdHash: attempt.accountIdHash,
      ipHash: attempt.ipHash,
      success: attempt.success,
      attemptedAt: attempt.attemptedAt,
    });
  }

  async summarizeAccount(accountIdHash: string): Promise<AccountAttemptSummary> {
    // Cap at 16 because the longest lockout tier (15 fails → 1h) only
    // needs the most recent 15 rows. Anything beyond that is irrelevant
    // to the policy and would just inflate the scan.
    const rows = await this.db
      .select({
        success: authLoginAttempts.success,
        attemptedAt: authLoginAttempts.attemptedAt,
      })
      .from(authLoginAttempts)
      .where(eq(authLoginAttempts.accountIdHash, accountIdHash))
      .orderBy(desc(authLoginAttempts.attemptedAt))
      .limit(16);

    let consecutiveFails = 0;
    let lastFailureAt: Date | null = null;
    for (const row of rows) {
      if (row.success) break;
      if (lastFailureAt === null) lastFailureAt = row.attemptedAt;
      consecutiveFails += 1;
    }
    return { consecutiveFails, lastFailureAt };
  }

  async deleteOlderThan(olderThan: Date): Promise<number> {
    const result = await this.db
      .delete(authLoginAttempts)
      .where(lt(authLoginAttempts.attemptedAt, olderThan));
    // Drizzle's delete returns a thin wrapper without a typed `rowCount`;
    // we read it defensively off the underlying `pg` result.
    const rowCount = (result as unknown as { rowCount?: number | null }).rowCount;
    return rowCount ?? 0;
  }
}

/**
 * Default retention window for the audit log — 30 days per the KASA-312
 * acceptance criteria. Re-exported here so the cleanup cron in
 * `apps/api/src/workers/login-attempts-cleanup.ts` shares the same
 * constant as the route layer.
 */
export const LOGIN_ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
