import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type StaffRole, staffRoleValues } from "../db/schema/staff.js";
import { sendError } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    staffPrincipal?: { userId: string; merchantId?: string; role?: StaffRole };
  }
}

const USER_ID_HEADER = "x-staff-user-id";
const MERCHANT_ID_HEADER = "x-staff-merchant-id";
const ROLE_HEADER = "x-staff-role";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readUuidHeader(req: FastifyRequest, header: string): string | null {
  const raw = req.headers[header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !UUID_RE.test(value)) return null;
  return value;
}

function readRoleHeader(req: FastifyRequest): StaffRole | null {
  const raw = req.headers[ROLE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  return (staffRoleValues as readonly string[]).includes(value) ? (value as StaffRole) : null;
}

function checkBearer(req: FastifyRequest, reply: FastifyReply, expected: Buffer): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    sendError(reply, 401, "unauthorized", "Staff bootstrap token required.");
    return false;
  }
  const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    sendError(reply, 401, "unauthorized", "Staff bootstrap token rejected.");
    return false;
  }
  return true;
}

/**
 * Placeholder staff-session enforcement, valid for the bootstrap window only.
 * Verifies a `Authorization: Bearer <STAFF_BOOTSTRAP_TOKEN>` header against
 * the env-configured token in constant time and reads the acting user id off
 * `X-Staff-User-Id`. The real staff session (cookie + Lucia-style backend)
 * lands in KASA-25 and replaces this preHandler without changing the route.
 */
export function makeStaffBootstrapPreHandler(expectedToken: string) {
  const expected = Buffer.from(expectedToken, "utf8");
  return async function requireStaffSession(req: FastifyRequest, reply: FastifyReply) {
    if (!checkBearer(req, reply, expected)) return reply;
    const userId = readUuidHeader(req, USER_ID_HEADER);
    if (!userId) {
      sendError(
        reply,
        400,
        "bad_request",
        `Header ${USER_ID_HEADER} must be a UUID identifying the acting staff user.`,
      );
      return reply;
    }
    req.staffPrincipal = { userId };
    return undefined;
  };
}

/**
 * Variant of `makeStaffBootstrapPreHandler` that additionally enforces
 * `X-Staff-Merchant-Id` and exposes it on `req.staffPrincipal.merchantId`.
 * Used by merchant-scoped write endpoints (e.g. `/v1/catalog/items`, KASA-23)
 * during the bootstrap window. KASA-25's real staff session will derive
 * `merchantId` from the session itself and drop the header.
 *
 * Optionally an `allowedRoles` allow-list can be supplied; the pre-handler
 * then also requires `X-Staff-Role` and rejects with 403 when the role is
 * not in the list. Owner-only admin endpoints (e.g. `/v1/admin/reconciliation`,
 * KASA-117) opt in this way. Once KASA-25's real staff session lands, the
 * role will be derived from the session and the header dropped without the
 * route handler changing.
 */
export interface MerchantScopedStaffPreHandlerOptions {
  /**
   * If set, the pre-handler also requires `X-Staff-Role` and 403s when the
   * presented role is not in the allow-list. Omit for endpoints that accept
   * any staff role.
   */
  allowedRoles?: readonly StaffRole[];
}

export function makeMerchantScopedStaffPreHandler(
  expectedToken: string,
  options: MerchantScopedStaffPreHandlerOptions = {},
) {
  const expected = Buffer.from(expectedToken, "utf8");
  const allowedRoles = options.allowedRoles ? new Set(options.allowedRoles) : null;
  return async function requireMerchantStaffSession(req: FastifyRequest, reply: FastifyReply) {
    if (!checkBearer(req, reply, expected)) return reply;
    const userId = readUuidHeader(req, USER_ID_HEADER);
    if (!userId) {
      sendError(
        reply,
        400,
        "bad_request",
        `Header ${USER_ID_HEADER} must be a UUID identifying the acting staff user.`,
      );
      return reply;
    }
    const merchantId = readUuidHeader(req, MERCHANT_ID_HEADER);
    if (!merchantId) {
      sendError(
        reply,
        400,
        "bad_request",
        `Header ${MERCHANT_ID_HEADER} must be a UUID identifying the target merchant.`,
      );
      return reply;
    }
    let role: StaffRole | undefined;
    if (allowedRoles) {
      const presented = readRoleHeader(req);
      if (!presented) {
        sendError(
          reply,
          400,
          "bad_request",
          `Header ${ROLE_HEADER} must be one of: ${staffRoleValues.join(", ")}.`,
        );
        return reply;
      }
      if (!allowedRoles.has(presented)) {
        sendError(
          reply,
          403,
          "forbidden",
          `Role '${presented}' is not permitted for this endpoint.`,
        );
        return reply;
      }
      role = presented;
    }
    req.staffPrincipal = { userId, merchantId, ...(role !== undefined ? { role } : {}) };
    return undefined;
  };
}
