import type { StaffRole } from "../../db/schema/staff.js";

/**
 * Read-only staff record exposed to the auth layer. Kept narrow so the
 * route layer can't accidentally couple to columns the session flow
 * doesn't need — anything beyond email + password verification belongs
 * in a feature-specific service.
 */
export interface StaffAuthRecord {
  id: string;
  merchantId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: StaffRole;
}

/**
 * Lookup contract for `POST /v1/auth/session/login`. The session flow
 * fetches by lower-cased email; implementations are responsible for the
 * case-insensitive match (DB collation or explicit `lower(email)`).
 */
export interface StaffRepository {
  findByEmail(email: string): Promise<StaffAuthRecord | null>;
}
