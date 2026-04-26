import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { referencePullQuery, type ReferencePullQuery } from "@kassa/schemas";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { sendError } from "../lib/errors.js";
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

    const gatedPreHandler = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireStaff) {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable outlet reads until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireStaff(req, reply);
    };

    // GET /v1/outlets — merchant-scoped delta pull (KASA-122).
    app.get<{ Querystring: ReferencePullQuery }>(
      "/",
      { preHandler: [gatedPreHandler, validate({ query: referencePullQuery })] },
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

    // GET /v1/outlets/:outletId — single-outlet detail (KASA-122 follow-up
    // PRs may extend this; for now it remains 501 because the pull endpoint is
    // sufficient for KASA-68 and the detail shape is undefined).
    app.get("/:outletId", async (_req, reply) => {
      sendError(reply, 501, "not_implemented", "Outlet detail endpoint is not yet implemented.");
      return reply;
    });
  };
}
