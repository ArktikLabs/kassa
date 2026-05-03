import { createHmac, timingSafeEqual } from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply } from "fastify";
import type { StaffRole } from "../db/schema/staff.js";

/**
 * Staff session cookie name. `__Host-` prefix is intentionally avoided
 * because the back-office and API are on different registrable domains
 * (`*.pages.dev` vs `kassa.fly.dev`) — the prefix would force the
 * cookie to the API host AND require a literal `Path=/`, which works
 * but adds zero security on top of `Secure` + `HttpOnly` + `SameSite`.
 */
export const STAFF_SESSION_COOKIE = "kassa_session";

/**
 * Rolling 30-day expiration per ARCHITECTURE.md §4.1. The same value is
 * encoded into the signed cookie payload so a stolen cookie cannot
 * outlive its issuer-side `expiresAt`, even if a future deploy widens
 * the cookie `Max-Age`.
 */
export const STAFF_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StaffSessionPayload {
  userId: string;
  merchantId: string;
  email: string;
  displayName: string;
  role: StaffRole;
  /** Issued-at, ms since epoch. */
  iat: number;
  /** Expires-at, ms since epoch. */
  exp: number;
}

/**
 * Sign a session payload with HMAC-SHA-256. The output is
 * `<base64url(payload)>.<base64url(sig)>` — opaque from the client's
 * point of view but reversible by the server to recover the principal
 * without a database round-trip. The cookie is set HTTP-only so the
 * browser cannot read it in JS regardless.
 */
export function signSessionCookie(payload: StaffSessionPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type SessionVerifyError = "malformed" | "bad_signature" | "bad_payload" | "expired";

/**
 * Inverse of `signSessionCookie`. Verifies the HMAC in constant time
 * and rejects expired payloads against the supplied `now`. Returns a
 * tagged result so callers can log the specific failure reason without
 * leaking it to the response.
 */
export function verifySessionCookie(
  cookieValue: string,
  secret: string,
  now: Date = new Date(),
): { ok: true; payload: StaffSessionPayload } | { ok: false; error: SessionVerifyError } {
  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) {
    return { ok: false, error: "malformed" };
  }
  const body = cookieValue.slice(0, dot);
  const presentedSig = cookieValue.slice(dot + 1);
  const expectedSig = createHmac("sha256", secret).update(body).digest("base64url");
  const presentedBuf = Buffer.from(presentedSig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (
    presentedBuf.length === 0 ||
    presentedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(presentedBuf, expectedBuf)
  ) {
    return { ok: false, error: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "bad_payload" };
  }
  if (!isStaffSessionPayload(parsed)) {
    return { ok: false, error: "bad_payload" };
  }
  if (parsed.exp <= now.getTime()) {
    return { ok: false, error: "expired" };
  }
  return { ok: true, payload: parsed };
}

export interface IssueSessionCookieInput {
  reply: FastifyReply;
  payload: StaffSessionPayload;
  secret: string;
  /** Override cookie attributes — used by tests to drop `Secure` on injected requests. */
  cookieOptions?: Partial<CookieSerializeOptions>;
}

/**
 * Set the session cookie on the reply with the architecture-specified
 * attributes (HTTP-only, SameSite=Lax, Secure, signed, rolling 30-day
 * Max-Age). The path is `/` so the cookie also rides on
 * `/v1/auth/session/logout`.
 */
export function issueSessionCookie(input: IssueSessionCookieInput): void {
  const value = signSessionCookie(input.payload, input.secret);
  const ttlSeconds = Math.max(1, Math.floor((input.payload.exp - input.payload.iat) / 1000));
  input.reply.setCookie(STAFF_SESSION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ttlSeconds,
    ...input.cookieOptions,
  });
}

function isStaffSessionPayload(value: unknown): value is StaffSessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === "string" &&
    typeof v.merchantId === "string" &&
    typeof v.email === "string" &&
    typeof v.displayName === "string" &&
    typeof v.role === "string" &&
    typeof v.iat === "number" &&
    typeof v.exp === "number"
  );
}
