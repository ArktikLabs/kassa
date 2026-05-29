import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  outletDetailParam,
  outletPullResponse,
  outletRecord,
  outletUpdateRequest,
  referencePullQuery,
  type OutletUpdateRequest,
  type ReferencePullQuery,
} from "@kassa/schemas";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { sendError } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { OutletError, type OutletsService, toOutletResponse } from "../services/outlets/index.js";

export interface OutletsRouteDeps {
  outlets: OutletsService;
  /**
   * Bootstrap window only. KASA-25 replaces this with the real staff session
   * preHandler; until then the read paths require a staff bootstrap token +
   * `X-Staff-Merchant-Id` so tenant scoping can't be impersonated.
   */
  staffBootstrapToken?: string;
}

/**
 * KASA-367 — receipt branding edits are owner-only. Aligns with merchant
 * settings (KASA-219), which gate the same surface area at the merchant
 * level. Cashier and read-only roles get a 403 from the preHandler.
 */
const OUTLET_WRITE_ROLES = ["owner"] as const;

function requireStaffPrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
): { userId: string; merchantId: string } | null {
  const principal = req.staffPrincipal;
  if (!principal?.merchantId) {
    sendError(reply, 401, "unauthorized", "Staff session missing.");
    return null;
  }
  return { userId: principal.userId, merchantId: principal.merchantId };
}

export function outletsRoutes(deps: OutletsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireStaff = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken)
      : null;
    const requireStaffWrite = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken, {
          allowedRoles: OUTLET_WRITE_ROLES,
        })
      : null;

    const makeGate = (handler: ReturnType<typeof makeMerchantScopedStaffPreHandler> | null) => {
      if (handler) return handler;
      return async (_req: FastifyRequest, reply: FastifyReply) => {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable outlet reads until KASA-25 ships staff sessions.",
        );
        return reply;
      };
    };
    const gatedPreHandler = makeGate(requireStaff);
    const gatedWritePreHandler = makeGate(requireStaffWrite);

    // GET /v1/outlets — merchant-scoped delta pull (KASA-122).
    app.get<{ Querystring: ReferencePullQuery }>(
      "/",
      {
        schema: {
          tags: ["outlets"],
          summary: "Pull outlets (delta)",
          description:
            "Merchant-scoped delta pull. Mirrors the catalog pull envelope; " +
            "see `GET /v1/catalog/items` for cursor / page-token semantics.",
          response: {
            200: outletPullResponse,
            400: errorBodySchema,
            401: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedPreHandler, validate({ query: referencePullQuery })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        try {
          const result = await deps.outlets.list({
            merchantId: principal.merchantId,
            ...(req.query.updatedAfter !== undefined
              ? { updatedAfter: new Date(req.query.updatedAfter) }
              : {}),
            ...(req.query.pageToken !== undefined ? { pageToken: req.query.pageToken } : {}),
            ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
          });
          reply.code(200).send({
            records: result.records.map(toOutletResponse),
            nextCursor: result.nextCursor ? result.nextCursor.toISOString() : null,
            nextPageToken: result.nextPageToken,
          });
          return reply;
        } catch (err) {
          if (err instanceof OutletError && err.code === "invalid_page_token") {
            sendError(reply, 400, "invalid_page_token", err.message);
            return reply;
          }
          throw err;
        }
      },
    );

    // GET /v1/outlets/:outletId — single-outlet detail (reserved).
    app.get(
      "/:outletId",
      {
        schema: {
          tags: ["outlets"],
          summary: "Get outlet detail (not implemented)",
          description:
            "Reserved for the per-outlet detail view. Returns 501 until the " +
            "detail shape is defined; the delta-pull endpoint is sufficient " +
            "for the KASA-68 acceptance flow.",
          response: notImplementedResponses,
        },
      },
      async (_req, reply) => {
        sendError(reply, 501, "not_implemented", "Outlet detail endpoint is not yet implemented.");
        return reply;
      },
    );

    // PATCH /v1/outlets/:outletId — owner-only receipt branding edit (KASA-367).
    app.patch<{ Params: { outletId: string }; Body: OutletUpdateRequest }>(
      "/:outletId",
      {
        schema: {
          tags: ["outlets"],
          summary: "Update outlet receipt branding (KASA-367)",
          description:
            "Owner-only. Partial PATCH: `undefined` leaves a field unchanged, " +
            "`null` clears it, a string overwrites. Empty body is a 422 " +
            "(`validation_error`).",
          response: {
            200: outletRecord,
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [
          gatedWritePreHandler,
          validate({ params: outletDetailParam, body: outletUpdateRequest }),
        ],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        try {
          const row = await deps.outlets.update({
            merchantId: principal.merchantId,
            outletId: req.params.outletId,
            patch: req.body,
          });
          reply.code(200).send(toOutletResponse(row));
          return reply;
        } catch (err) {
          if (err instanceof OutletError && err.code === "outlet_not_found") {
            sendError(reply, 404, "outlet_not_found", err.message);
            return reply;
          }
          throw err;
        }
      },
    );
  };
}
