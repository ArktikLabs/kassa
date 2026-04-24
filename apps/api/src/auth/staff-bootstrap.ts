import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    staffPrincipal?: { userId: string };
  }
}

const USER_ID_HEADER = "x-staff-user-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      sendError(reply, 401, "unauthorized", "Staff bootstrap token required.");
      return reply;
    }
    const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      sendError(reply, 401, "unauthorized", "Staff bootstrap token rejected.");
      return reply;
    }
    const userIdHeader = req.headers[USER_ID_HEADER];
    const userId = Array.isArray(userIdHeader) ? userIdHeader[0] : userIdHeader;
    if (!userId || !UUID_RE.test(userId)) {
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
