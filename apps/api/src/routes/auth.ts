import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  deviceEnrolRequest,
  enrolmentCodeIssueRequest,
  type DeviceEnrolResponse,
  type EnrolmentCodeIssueResponse,
} from "@kassa/schemas/auth";
import { sendError, notImplemented } from "../lib/errors.js";
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

    app.post(
      "/enrolment-codes",
      {
        preHandler: async (req, reply) => {
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
      },
      async (req, reply) => {
        const parsed = enrolmentCodeIssueRequest.safeParse(req.body);
        if (!parsed.success) {
          sendError(reply, 400, "bad_request", "Invalid request body.", parsed.error.flatten());
          return reply;
        }
        const principal = req.staffPrincipal;
        if (!principal) {
          sendError(reply, 401, "unauthorized", "Staff session missing.");
          return reply;
        }
        try {
          const result = await deps.enrolment.issueCode({
            outletId: parsed.data.outletId,
            createdByUserId: principal.userId,
          });
          const body: EnrolmentCodeIssueResponse = {
            code: result.code,
            outletId: result.outletId,
            expiresAt: result.expiresAt.toISOString(),
          };
          reply.code(201).send(body);
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

    app.post(
      "/enroll",
      {
        config: {
          rateLimit: {
            max: deps.enrollRateLimitPerMinute ?? 10,
            timeWindow: "1 minute",
          },
        },
      },
      async (req, reply) => {
        const parsed = deviceEnrolRequest.safeParse(req.body);
        if (!parsed.success) {
          sendError(reply, 400, "bad_request", "Invalid request body.", parsed.error.flatten());
          return reply;
        }
        try {
          const result = await deps.enrolment.enrolDevice({
            code: parsed.data.code,
            deviceFingerprint: parsed.data.deviceFingerprint,
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
              deviceFingerprint: parsed.data.deviceFingerprint,
            },
            "device enrolled",
          );
          const body: DeviceEnrolResponse = {
            deviceId: result.deviceId,
            apiKey: result.apiKey,
            apiSecret: result.apiSecret,
            outlet: result.outlet,
            merchant: result.merchant,
          };
          reply.code(201).send(body);
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

    app.post("/heartbeat", async (req, reply) => notImplemented(req, reply));
    app.post("/pin/verify", async (req, reply) => notImplemented(req, reply));
    app.post("/session/login", async (req, reply) => notImplemented(req, reply));
    app.post("/session/logout", async (req, reply) => notImplemented(req, reply));
  };
}
