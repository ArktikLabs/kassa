/**
 * Base URL for the Kassa API. Overridable via `VITE_API_BASE_URL`; defaults to
 * empty so a same-origin reverse-proxy deploy works without build-time config.
 * Mirrors `apps/pos/src/data/api/config.ts` (ARCHITECTURE §4 — single API
 * surface under `/v1/*`).
 */
export function apiBaseUrl(): string {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (typeof v === "string" && v.length > 0) return v.replace(/\/$/, "");
  return "";
}

/**
 * `true` when a developer or deploy has supplied an explicit API base URL.
 * Used by the login screen to surface a clear "API not configured" error
 * instead of silently posting to the SPA origin (which has no `/v1/*`).
 */
export function isApiBaseUrlConfigured(): boolean {
  const v = import.meta.env.VITE_API_BASE_URL;
  return typeof v === "string" && v.length > 0;
}
