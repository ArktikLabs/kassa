import type { StaffRole } from "../../db/schema/staff.js";

/**
 * Read-only staff record exposed to the auth layer. Kept narrow so the
 * route layer can't accidentally couple to columns the session flow
 * doesn't need — anything beyond email + password verification belongs
 * in a feature-specific service.
 *
 * `pinHash` is the argon2id hash of the lock-screen / manager-override
 * PIN (KASA-236-A). Null when the staff member has not enrolled a PIN
 * yet — callers that depend on it (e.g. void-route manager auth) must
 * still run argon2.verify against a timing-decoy to avoid leaking the
 * "no PIN configured" branch through response timing.
 */
export interface StaffAuthRecord {
  id: string;
  merchantId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: StaffRole;
  pinHash: string | null;
}

/**
 * Lookup contract for `POST /v1/auth/session/login` plus the
 * KASA-236-A void-route manager-PIN check. The session flow fetches by
 * lower-cased email; implementations are responsible for the case-
 * insensitive match (DB collation or explicit `lower(email)`).
 */
export interface StaffRepository {
  findByEmail(email: string): Promise<StaffAuthRecord | null>;
  /**
   * KASA-236-A — fetch a staff row by primary key, gated on `merchantId`
   * so cross-tenant staff ids never resolve to another merchant's row.
   * Used by `SalesService.void` to verify the manager PIN.
   */
  findById(input: { merchantId: string; staffId: string }): Promise<StaffAuthRecord | null>;
}
