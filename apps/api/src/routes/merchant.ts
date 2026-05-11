import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  merchantMeResponse,
  merchantSettingsUpdateRequest,
  type MerchantSettingsUpdateRequest,
} from "@kassa/schemas";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { sendError } from "../lib/errors.js";
import { errorBodySchema } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { MerchantError, type MerchantsService } from "../services/merchants/index.js";

export interface MerchantRouteDeps {
  merchants: MerchantsService;
  /**
   * Bootstrap window only. KASA-25 replaces this with the real staff session
   * preHandler; until then merchant settings reads/writes require a staff
   * bootstrap token + `X-Staff-Merchant-Id` so tenant scoping can't be
   * impersonated. PATCH additionally enforces `X-Staff-Role: owner`.
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

export function merchantRoutes(deps: MerchantRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // Read path is open to any authenticated staff role: cashiers and
    // read-only staff still need to render the receipt header in the POS.
    const requireAnyStaff = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken)
      : null;
    // Write path mirrors `/v1/admin/reconciliation` — owner-only until
    // KASA-25 ships the real session.
    const requireOwner = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken, { allowedRoles: ["owner"] })
      : null;

    const readGate = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireAnyStaff) {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable merchant settings reads until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireAnyStaff(req, reply);
    };

    const writeGate = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireOwner) {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable merchant settings writes until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireOwner(req, reply);
    };

    // GET /v1/merchant/me — return the merchant identity + receipt branding
    // for the staff session's merchant. The POS sync runner pulls this so
    // every printed/PDF receipt carries the latest header/footer.
    app.get(
      "/me",
      {
        schema: {
          tags: ["merchant"],
          summary: "Get merchant settings",
          description:
            "Returns the merchant identity + receipt branding for the " +
            "staff session's merchant (KASA-219). The `displayName` falls back " +
            "to the merchant's legacy `name` until the owner edits the " +
            "settings page so a brand-new merchant still prints a header.",
          response: {
            200: merchantMeResponse,
            401: errorBodySchema,
            404: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: readGate,
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        try {
          const body = await deps.merchants.getMe(principal.merchantId);
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof MerchantError && err.code === "merchant_not_found") {
            sendError(reply, 404, "merchant_not_found", err.message);
            return reply;
          }
          throw err;
        }
      },
    );

    // PATCH /v1/merchant — owner-only partial update of receipt branding.
    // Validation lives in `merchantSettingsUpdateRequest` (NPWP /^\d{16}$/,
    // length caps, phone charset). Returns the updated merchantMeResponse so
    // the back-office page can refresh without a follow-up GET.
    app.patch<{ Body: MerchantSettingsUpdateRequest }>(
      "/",
      {
        schema: {
          tags: ["merchant"],
          summary: "Update merchant settings",
          description:
            "Owner-only. Partially updates the receipt branding fields " +
            "(KASA-219). NPWP must be exactly 16 digits if present; phone, " +
            "address, footer text, and display name have length caps " +
            "enforced by `merchantSettingsUpdateRequest`. Returns the full " +
            "`merchantMeResponse` after the write.",
          response: {
            200: merchantMeResponse,
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [writeGate, validate({ body: merchantSettingsUpdateRequest })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        try {
          const body = await deps.merchants.updateSettings(principal.merchantId, req.body);
          reply.code(200).send(body);
          return reply;
        } catch (err) {
          if (err instanceof MerchantError && err.code === "merchant_not_found") {
            sendError(reply, 404, "merchant_not_found", err.message);
            return reply;
          }
          throw err;
        }
      },
    );
  };
}
