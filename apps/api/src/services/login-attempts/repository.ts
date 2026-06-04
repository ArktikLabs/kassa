/**
 * Storage contract for the brute-force attempts audit log
 * (`auth_login_attempts`, KASA-312). The route layer only ever talks to
 * this interface so the in-memory and Postgres implementations stay
 * swappable, and the lockout policy can be unit-tested without a DB.
 */
export interface RecordedLoginAttempt {
  accountIdHash: string;
  ipHash: string;
  success: boolean;
  attemptedAt: Date;
}

export interface AccountAttemptSummary {
  /** Number of failed attempts since the most recent success (or all-time if no success exists). */
  consecutiveFails: number;
  /** Timestamp of the most recent failure included in `consecutiveFails`, or null when zero. */
  lastFailureAt: Date | null;
}

export interface LoginAttemptsRepository {
  record(attempt: RecordedLoginAttempt): Promise<void>;
  /**
   * Walk the attempts log newest-first and count failures up to (but not
   * including) the most recent success. Used by the route to decide
   * whether the next attempt is locked out.
   */
  summarizeAccount(accountIdHash: string): Promise<AccountAttemptSummary>;
  /**
   * Delete rows older than `olderThan`. Returns the number of rows removed.
   * Called by the daily cleanup cron (apps/api/src/workers) — the route
   * never runs this synchronously.
   */
  deleteOlderThan(olderThan: Date): Promise<number>;
}
