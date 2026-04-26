import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  deviceEnrolRequest,
  deviceEnrolResponse,
  enrolmentCodeIssueRequest,
  enrolmentCodeIssueResponse,
  type DeviceEnrolRequest,
  type DeviceEnrolResponse,
  type EnrolmentCodeIssueRequest,
  type EnrolmentCodeIssueResponse,
} from "@kassa/schemas/auth";
import { sendError, notImplemented } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { EnrolmentError, type EnrolmentService } from "../services/enrolment/index.js";
import { makeStaffBootstrapPreHandler } from "../auth/staff-bootstrap.js";

export interface AuthRouteDeps {
  enrolment: EnrolmentService;
  staffBootstrapToken?: string;
  /** Per-IP requests per minute against `/v1/auth/enroll`. Defaults to 10. */
  enrollRateLimitPerMinute?: number;
}

export function authRoutes(deps: AuthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireStaff = deps.staffBootstrapToken
      ? makeStaffBootstrapPreHandler(deps.staffBootstrapToken)
      : null;

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
            "Staff-only. Mints an 8-character single-use code (10-minute TTL by " +
            "default) bound to an outlet. Until KASA-25 ships staff sessions, " +
            "the caller must present `Authorization: Bearer <STAFF_BOOTSTRAP_TOKEN>` " +
            "and `X-Staff-User-Id: <uuid>` headers; when the bootstrap token is " +
            "unset the endpoint returns 503.",
          response: {
            201: enrolmentCodeIssueResponse,
            401: errorBodySchema,
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
    app.post(
      "/session/login",
      {
        schema: {
          tags: ["auth"],
          summary: "Open a staff session (not implemented)",
          description: "Reserved for staff session login. Lands with KASA-25.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
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
