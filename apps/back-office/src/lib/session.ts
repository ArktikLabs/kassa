/*
 * Session stub for the back-office shell.
 *
 * v0 back-office is scaffolded against the auth contract in
 * ARCHITECTURE.md §4.1 (email + password → staff session cookie; PIN
 * unlock after inactivity). The real session lives server-side and
 * lands in a follow-up ticket. Until then we persist a role + display
 * name locally so the shell can demo role-gated routes and the
 * "Logout" affordance.
 */

export const STAFF_ROLES = ["owner", "manager", "cashier", "read_only"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/* Roles permitted into the sensitive manager surface. Kept in one
 * place so route guards can call a single predicate. */
const MANAGER_ROLES: readonly StaffRole[] = ["owner", "manager"];

export function roleCanManage(role: StaffRole): boolean {
  return MANAGER_ROLES.includes(role);
}

/* Owner-only predicate for sensitive actions like the manual
 * static-QRIS reconciliation match (KASA-64 §static-QRIS, KASA-119).
 * Manager can read these surfaces but cannot flip a tender to
 * verified — only the outlet owner can. */
export function roleIsOwner(role: StaffRole): boolean {
  return role === "owner";
}

export type Session = {
  email: string;
  displayName: string;
  role: StaffRole;
  /* Tenant scope for merchant-scoped reads (catalog, outlets, reports).
   * Returned by `POST /v1/auth/session/login` per ARCHITECTURE §4.1 and
   * pinned by the schema docstring in @kassa/schemas/auth. */
  merchantId: string;
  issuedAt: string;
};

const SESSION_KEY = "kassa.back-office.session";

export function loadSession(): Session | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Session;
    if (!STAFF_ROLES.includes(parsed.role)) return null;
    if (typeof parsed.merchantId !== "string" || parsed.merchantId.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(SESSION_KEY);
}

export function isAuthenticated(): boolean {
  return loadSession() !== null;
}
