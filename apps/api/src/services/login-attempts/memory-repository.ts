import type {
  AccountAttemptSummary,
  LoginAttemptsRepository,
  RecordedLoginAttempt,
} from "./repository.js";

/**
 * In-memory `auth_login_attempts` for tests and the bootstrap window
 * before the Pg-backed repo lands. The store is unbounded — production
 * callers must use `PgLoginAttemptsRepository` so the 30-day cleanup
 * cron can keep the table from growing forever.
 */
export class InMemoryLoginAttemptsRepository implements LoginAttemptsRepository {
  private readonly rows: RecordedLoginAttempt[] = [];

  async record(attempt: RecordedLoginAttempt): Promise<void> {
    this.rows.push({ ...attempt });
  }

  async summarizeAccount(accountIdHash: string): Promise<AccountAttemptSummary> {
    // Newest first — count failures until we hit a success (or run out).
    let consecutiveFails = 0;
    let lastFailureAt: Date | null = null;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i]!;
      if (row.accountIdHash !== accountIdHash) continue;
      if (row.success) break;
      if (lastFailureAt === null) lastFailureAt = row.attemptedAt;
      consecutiveFails += 1;
    }
    return { consecutiveFails, lastFailureAt };
  }

  async deleteOlderThan(olderThan: Date): Promise<number> {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]!.attemptedAt < olderThan) this.rows.splice(i, 1);
    }
    return before - this.rows.length;
  }
}
