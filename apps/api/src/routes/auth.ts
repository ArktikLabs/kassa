import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import argon2 from "argon2";
import {
  deviceEnrolRequest,
  deviceEnrolResponse,
  enrolmentCodeIssueRequest,
  enrolmentCodeIssueResponse,
  sessionLoginRequest,
  sessionLoginResponse,
  type DeviceEnrolRequest,
  type DeviceEnrolResponse,
  type EnrolmentCodeIssueRequest,
  type EnrolmentCodeIssueResponse,
  type SessionLoginRequest,
  type SessionLoginResponse,
} from "@kassa/schemas/auth";
import { sendError, notImplemented } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { EnrolmentError, type EnrolmentService } from "../services/enrolment/index.js";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import {
  STAFF_SESSION_TTL_MS,
  issueSessionCookie,
  type StaffSessionPayload,
} from "../auth/staff-session.js";
import type { StaffRepository } from "../services/staff/index.js";
import type { StaffRole } from "../db/schema/staff.js";

const ENROLMENT_CODE_ISSUE_ROLES: readonly StaffRole[] = ["owner", "manager"];

/**
 * Argon2id options mirror the device-secret hasher (services/enrolment
 * /credentials.ts) so the verify call against the timing-decoy hash
 * costs the same CPU as a real staff password verify. Tuned to OWASP
 * 2023 minimums.
 */
const STAFF_PASSWORD_ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface AuthRouteDeps {
  enrolment: EnrolmentService;
  staffBootstrapToken?: string;
  /** Per-IP requests per minute against `/v1/auth/enroll`. Defaults to 10. */
  enrollRateLimitPerMinute?: number;
  /**
   * Staff record source for `POST /v1/auth/session/login`. When omitted the
   * login route returns 503 `not_configured` so deploys without a wired
   * repository surface a clean failure instead of throwing on a null deref.
   */
  staffRepository?: StaffRepository;
  /**
   * HMAC secret used to sign the session cookie. Required when
   * `staffRepository` is set; the route refuses to start signing
   * cookies with an empty secret.
   */
  sessionCookieSecret?: string;
  /** Per-IP requests per minute against `/v1/auth/session/login`. Defaults to 5. */
  loginRateLimitPerMinute?: number;
  /** Test seam — overrides `Date.now()` for the issuedAt/expiresAt stamps. */
  now?: () => Date;
  /**
   * Test seam — partial cookie attribute overrides forwarded to
   * `reply.setCookie`. The handler always defaults to `Secure;
   * HttpOnly; SameSite=Lax`; tests using `app.inject` (no TLS) drop
   * `Secure` here so the cookie can round-trip.
   */
  sessionCookieOptions?: Partial<CookieSerializeOptions>;
}

export function authRoutes(deps: AuthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireStaff = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken, {
          allowedRoles: ENROLMENT_CODE_ISSUE_ROLES,
        })
      : null;

    const now = deps.now ?? (() => new Date());

    // Pre-computed timing decoy: argon2.verify against this hash for the
    // "no such email" path so the response time matches a real wrong-password
    // attempt. Computed once at register time — the literal plaintext is
    // unused, only the CPU cost of verify matters.
    const timingDecoyHash = await argon2.hash(
      "kassa-timing-decoy-not-a-real-secret",
      STAFF_PASSWORD_ARGON2_OPTIONS,
    );

    // In-memory limiter; devops will swap the store to the Redis chosen for
    // BullMQ once the Fly.io worker plane has more than one instance,
    // otherwise per-instance counters defeat the limit.
    await app.register(rateLimit, { global: false });

    app.post<{ Body: EnrolmentCodeIssueRequest }>(
      "/enrolment-codes",
      {
        // Body validation lives in the `validate()` preHandler so failures
        // surface as 422 `validation_error` per the existing API contract.
        // The schema below is consumed by `@fastify/swagger` for OpenAPI
        // generation only — no runtime body validation happens here.
        schema: {
          tags: ["auth"],
          summary: "Issue an enrolment code",
          description:
            "Owner/manager-only. Mints an 8-character single-use code (10-minute " +
            "TTL by default) bound to an outlet. Until KASA-25 ships staff " +
            "sessions, the caller must present `Authorization: Bearer " +
            "<STAFF_BOOTSTRAP_TOKEN>` plus `X-Staff-User-Id`, " +
            "`X-Staff-Merchant-Id`, and `X-Staff-Role` headers; the role must be " +
            "`owner` or `manager` (cashiers and read-only staff get 403). When " +
            "the bootstrap token is unset the endpoint returns 503.",
          response: {
            201: enrolmentCodeIssueResponse,
            400: errorBodySchema,
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [
          async (req, reply) => {
            if (!requireStaff) {
              sendError(
                reply,
                503,
                "staff_bootstrap_disabled",
                "Set STAFF_BOOTSTRAP_TOKEN to enable enrolment-code issuance until KASA-25 ships staff sessions.",
              );
              return reply;
            }
            return requireStaff(req, reply);
          },
          validate({ body: enrolmentCodeIssueRequest }),
        ],
      },
      async (req, reply) => {
        const principal = req.staffPrincipal;
        if (!principal) {
          sendError(reply, 401, "unauthorized", "Staff session missing.");
          return reply;
        }
        try {
          const result = await deps.enrolment.issueCode({
            outletId: req.body.outletId,
            createdByUserId: principal.userId,
          });
          const responseBody: EnrolmentCodeIssueResponse = {
            code: result.code,
            outletId: result.outletId,
            expiresAt: result.expiresAt.toISOString(),
          };
          reply.code(201).send(responseBody);
          return reply;
        } catch (err) {
          if (err instanceof EnrolmentError && err.code === "outlet_not_found") {
            sendError(reply, 404, "outlet_not_found", err.message);
            return reply;
          }
          throw err;
        }
      },
    );

    app.post<{ Body: DeviceEnrolRequest }>(
      "/enroll",
      {
        schema: {
          tags: ["auth"],
          summary: "Enrol a device",
          description:
            "Exchanges a single-use enrolment code plus a stable device " +
            "fingerprint for `{ deviceId, apiKey, apiSecret, outlet, merchant }`. " +
            "Rate-limited to 10 requests per minute per IP by default. " +
            "Returns 410 (`code_expired` or `code_already_used`) when the code " +
            "is past its TTL or has been redeemed.",
          response: {
            201: deviceEnrolResponse,
            404: errorBodySchema,
            410: errorBodySchema,
            422: errorBodySchema,
            429: errorBodySchema,
          },
        },
        config: {
          rateLimit: {
            max: deps.enrollRateLimitPerMinute ?? 10,
            timeWindow: "1 minute",
          },
        },
        preHandler: validate({ body: deviceEnrolRequest }),
      },
      async (req, reply) => {
        try {
          const result = await deps.enrolment.enrolDevice({
            code: req.body.code,
            deviceFingerprint: req.body.deviceFingerprint,
          });
          // Structured audit line: the fingerprint is persisted on
          // `devices.fingerprint`, but the log keeps ops correlation cheap
          // for the "recent enrolments" view without a DB round-trip.
          req.log.info(
            {
              event: "device.enrolled",
              deviceId: result.deviceId,
              outletId: result.outlet.id,
              merchantId: result.merchant.id,
              deviceFingerprint: req.body.deviceFingerprint,
            },
            "device enrolled",
          );
          const responseBody: DeviceEnrolResponse = {
            deviceId: result.deviceId,
            apiKey: result.apiKey,
            apiSecret: result.apiSecret,
            outlet: result.outlet,
            merchant: result.merchant,
          };
          reply.code(201).send(responseBody);
          return reply;
        } catch (err) {
          if (err instanceof EnrolmentError) {
            if (err.code === "code_not_found") {
              sendError(reply, 404, "code_not_found", err.message);
              return reply;
            }
            if (err.code === "code_expired" || err.code === "code_already_used") {
              sendError(reply, 410, err.code, err.message);
              return reply;
            }
          }
          throw err;
        }
      },
    );

    app.post(
      "/heartbeat",
      {
        schema: {
          tags: ["auth"],
          summary: "Device heartbeat (not implemented)",
          description: "Reserved for device liveness pings. Lands with KASA-25.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
    );
    app.post(
      "/pin/verify",
      {
        schema: {
          tags: ["auth"],
          summary: "Verify staff PIN (not implemented)",
          description: "Reserved for the staff-PIN gate on shift handoff. Lands with KASA-26.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
    );

    app.post<{ Body: SessionLoginRequest }>(
      "/session/login",
      {
        schema: {
          tags: ["auth"],
          summary: "Open a staff session",
          description:
            "Verifies email + password against the staff record and issues a " +
            "signed HTTP-only session cookie (`SameSite=Lax`, `Secure`, " +
            "30-day rolling Max-Age). Returns the staff identity the back-office " +
            "needs to render the shell. 401 on bad credentials; 429 when the " +
            "per-IP rate limit (5/min by default) trips. 503 when the route " +
            "has not been configured with a staff repository or session secret.",
          response: {
            200: sessionLoginResponse,
            401: errorBodySchema,
            422: errorBodySchema,
            429: errorBodySchema,
            503: errorBodySchema,
          },
        },
        config: {
          rateLimit: {
            max: deps.loginRateLimitPerMinute ?? 5,
            timeWindow: "1 minute",
          },
        },
        preHandler: validate({ body: sessionLoginRequest }),
      },
      async (req, reply) => {
        if (!deps.staffRepository || !deps.sessionCookieSecret) {
          sendError(
            reply,
            503,
            "not_configured",
            "Staff session login is not configured on this deploy.",
          );
          return reply;
        }
        const email = req.body.email.trim().toLowerCase();
        const password = req.body.password;

        const staff = await deps.staffRepository.findByEmail(email);
        // Hash to compare against — the decoy keeps "no such email" and
        // "wrong password" indistinguishable on the wire even though the
        // 401 message is the same; argon2 verify is the long pole, so a
        // missing user that skips the call gives a free probe oracle.
        const hashToCheck = staff?.passwordHash ?? timingDecoyHash;
        let passwordOk = false;
        try {
          passwordOk = await argon2.verify(hashToCheck, password);
        } catch (err) {
          // argon2 throws on malformed hashes (e.g. a hand-edited row);
          // log and treat as auth failure rather than 500 so a single
          // corrupt row can't take the login route down.
          req.log.warn({ err, email }, "staff password verify threw");
          passwordOk = false;
        }
        if (!staff || !passwordOk) {
          req.log.info(
            {
              event: "staff_login.rejected",
              email,
              reason: staff ? "bad_password" : "unknown_email",
            },
            "staff login rejected",
          );
          sendError(reply, 401, "invalid_credentials", "Email or password is incorrect.");
          return reply;
        }

        const issuedAt = now();
        const expiresAt = new Date(issuedAt.getTime() + STAFF_SESSION_TTL_MS);
        const payload: StaffSessionPayload = {
          userId: staff.id,
          merchantId: staff.merchantId,
          email: staff.email,
          displayName: staff.displayName,
          role: staff.role,
          iat: issuedAt.getTime(),
          exp: expiresAt.getTime(),
        };
        issueSessionCookie({
          reply,
          payload,
          secret: deps.sessionCookieSecret,
          ...(deps.sessionCookieOptions ? { cookieOptions: deps.sessionCookieOptions } : {}),
        });

        const responseBody: SessionLoginResponse = {
          email: staff.email,
          displayName: staff.displayName,
          role: staff.role,
          merchantId: staff.merchantId,
          issuedAt: issuedAt.toISOString(),
        };
        req.log.info(
          { event: "staff_login.accepted", userId: staff.id, merchantId: staff.merchantId },
          "staff login accepted",
        );
        reply.code(200).send(responseBody);
        return reply;
      },
    );

    app.post(
      "/session/logout",
      {
        schema: {
          tags: ["auth"],
          summary: "Close a staff session (not implemented)",
          description: "Reserved for staff session logout. Lands with KASA-25.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
    );
  };
}
