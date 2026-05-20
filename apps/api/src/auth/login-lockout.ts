import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Progressive per-account lockout policy (KASA-312, ARCHITECTURE §5).
 *
 * The thresholds match the ones documented on the issue: 5 consecutive
 * failures → 30s, 10 → 5m, 15 → 1h. "Consecutive" means "since the most
 * recent successful login for that account", so a single good password
 * resets the staircase. The function is pure so the route layer can
 * unit-test the policy independently of the attempts repository.
 *
 * Returning `null` means "no lockout" — the caller should attempt the
 * password verify. A non-null value is the lockout window applied to the
 * timestamp of the most recent failure; the route translates that into
 * the `Retry-After` header.
 */
export function nextLockout(consecutiveFails: number): { durationSeconds: number } | null {
  if (consecutiveFails >= 15) return { durationSeconds: 60 * 60 };
  if (consecutiveFails >= 10) return { durationSeconds: 5 * 60 };
  if (consecutiveFails >= 5) return { durationSeconds: 30 };
  return null;
}

/** Minimum length of `LOGIN_ATTEMPT_HMAC_SECRET` — enforced in `config.ts`. */
export const LOGIN_ATTEMPT_HMAC_SECRET_MIN_LENGTH = 32;

/**
 * HMAC-SHA256 the lower-cased email so the attempts table never stores
 * the plaintext (ADR-010, KASA-312 AC). Output is base64url so it's safe
 * to drop in Pino fields and Sentry breadcrumbs.
 *
 * The caller MUST normalize the email first (`trim().toLowerCase()`) so
 * a `BOB@x.id` retry collides with `bob@x.id` and exhausts the same
 * lockout bucket instead of opening a fresh one.
 */
export function hashAccountId(email: string, secret: string): string {
  return createHmac("sha256", secret).update(email).digest("base64url");
}

/**
 * HMAC-SHA256 the request IP. Same shape as `hashAccountId`. We don't
 * fold the user-agent in — IPv4 is already small enough to bucket cheaply
 * and the lockout is per-account anyway; the ip_hash is here so the audit
 * log can answer "did the attempts come from one source or many?"
 * without holding plaintext addresses.
 */
export function hashIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ip).digest("base64url");
}

/**
 * Constant-time hash comparison helper. Exported for tests that want to
 * assert two hashes are equal without leaking timing through the JS `===`
 * operator. Internal callers should keep using `===` on stored hashes —
 * this is for the rare case where a hash is being matched against
 * untrusted input.
 */
export function hashesEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
