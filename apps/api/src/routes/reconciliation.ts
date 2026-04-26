import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  reconciliationManualMatchRequest,
  type ReconciliationManualMatchRequest,
  type ReconciliationManualMatchResponse,
  reconciliationRunRequest,
  type ReconciliationRunRequest,
  type ReconciliationRunResponse,
} from "@kassa/schemas/reconciliation";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { sendError } from "../lib/errors.js";
import { validate } from "../lib/validate.js";
import type { ReconciliationService } from "../services/reconciliation/index.js";

export interface ReconciliationRouteDeps {
  service: ReconciliationService;
  /**
   * Bootstrap window only. KASA-25 replaces this with the real staff session
   * preHandler; until then admin endpoints require a staff bootstrap token,
   * `X-Staff-Merchant-Id`, and `X-Staff-Role: owner`.
   */
  staffBootstrapToken?: string;
}

function requireOwnerPrincipal(
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

export function reconciliationRoutes(deps: ReconciliationRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireStaff = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken, { allowedRoles: ["owner"] })
      : null;

    const gatedPreHandler = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireStaff) {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable reconciliation admin endpoints until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireStaff(req, reply);
    };

    // POST /v1/admin/reconciliation/run — trigger an EOD pass for a single
    // (outlet, businessDate). Owner-only. Mirrors the pass that BullMQ will
    // run nightly once KASA-111 lands the broker.
    app.post<{ Body: ReconciliationRunRequest }>(
      "/run",
      { preHandler: [gatedPreHandler, validate({ body: reconciliationRunRequest })] },
      async (req, reply) => {
        const principal = requireOwnerPrincipal(req, reply);
        if (!principal) return reply;
        const report = await deps.service.reconcileBusinessDate({
          merchantId: principal.merchantId,
          outletId: req.body.outletId,
          businessDate: req.body.businessDate,
        });
        const body: ReconciliationRunResponse = {
          outletId: req.body.outletId,
          businessDate: req.body.businessDate,
          matchedCount: report.matchedCount,
          consideredTenderCount: report.consideredTenderCount,
          settlementRowCount: report.settlementRowCount,
          matches: report.matches.map((m) => ({
            tenderId: m.tenderId,
            providerTransactionId: m.providerTransactionId,
            settledAt: m.settledAt,
          })),
          unmatchedTenderIds: [...report.unmatchedTenderIds],
          unmatchedSettlementIds: [...report.unmatchedSettlementIds],
        };
        reply.code(200).send(body);
        return reply;
      },
    );

    // POST /v1/admin/reconciliation/match — owner manually flips a stuck
    // tender. Owner-only. Idempotent: a re-POST against an already-verified
    // tender returns 200 with `outcome: "noop"` instead of an error so the
    // back-office page can retry safely.
    app.post<{ Body: ReconciliationManualMatchRequest }>(
      "/match",
      { preHandler: [gatedPreHandler, validate({ body: reconciliationManualMatchRequest })] },
      async (req, reply) => {
        const principal = requireOwnerPrincipal(req, reply);
        if (!principal) return reply;
        const outcome = await deps.service.manualMatch({
          merchantId: principal.merchantId,
          tenderId: req.body.tenderId,
          providerTransactionId: req.body.providerTransactionId,
          note: req.body.note,
          staffUserId: principal.userId,
        });
        if (outcome === "not_found") {
          sendError(
            reply,
            404,
            "tender_not_found",
            `No unverified tender ${req.body.tenderId} for this merchant.`,
          );
          return reply;
        }
        const body: ReconciliationManualMatchResponse = {
          tenderId: req.body.tenderId,
          outcome: outcome === "flipped" ? "flipped" : "noop",
        };
        reply.code(200).send(body);
        return reply;
      },
    );
  };
}
