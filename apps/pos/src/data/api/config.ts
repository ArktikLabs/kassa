/**
 * Base URL for the Kassa API. Overridable via `VITE_API_BASE_URL`; defaults to
 * same-origin so a reverse-proxy deploy (ARCHITECTURE.md §4) works without
 * build-time config. All paths in `src/data/api/*` are written as
 * `${apiBaseUrl()}/v1/...`.
 */
export function apiBaseUrl(): string {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (typeof v === "string" && v.length > 0) return v.replace(/\/$/, "");
  return "";
}
