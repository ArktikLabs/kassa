import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { itemCreateRequest, itemListQuery, itemUpdateRequest } from "@kassa/schemas/catalog";
import { notImplemented, sendError } from "../lib/errors.js";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import { ItemError, type ItemsService, toItemResponse } from "../services/catalog/index.js";

export interface CatalogRouteDeps {
  items: ItemsService;
  /**
   * Bootstrap window only. KASA-25 replaces this with the real staff session
   * preHandler; until then the CRUD write paths require a staff bootstrap
   * token + `X-Staff-Merchant-Id`.
   */
  staffBootstrapToken?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function handleItemError(reply: FastifyReply, err: ItemError): void {
  switch (err.code) {
    case "item_not_found":
      sendError(reply, 404, "item_not_found", err.message);
      return;
    case "uom_not_found":
      sendError(reply, 404, "uom_not_found", err.message);
      return;
    case "bom_not_found":
      sendError(reply, 404, "bom_not_found", err.message);
      return;
    case "item_code_conflict":
      sendError(reply, 409, "item_code_conflict", err.message);
      return;
    case "invalid_page_token":
      sendError(reply, 400, "invalid_page_token", err.message);
      return;
  }
}

export function catalogRoutes(deps: CatalogRouteDeps) {
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
          "Set STAFF_BOOTSTRAP_TOKEN to enable catalog CRUD until KASA-25 ships staff sessions.",
        );
        return reply;
      }
      return requireStaff(req, reply);
    };

    // GET /v1/catalog/items — merchant-scoped delta pull.
    app.get("/items", { preHandler: gatedPreHandler }, async (req, reply) => {
      const principal = requireStaffPrincipal(req, reply);
      if (!principal) return reply;
      const parsed = itemListQuery.safeParse(req.query);
      if (!parsed.success) {
        sendError(reply, 400, "bad_request", "Invalid query.", parsed.error.flatten());
        return reply;
      }
      try {
        const result = await deps.items.list({
          merchantId: principal.merchantId,
          ...(parsed.data.updatedAfter !== undefined
            ? { updatedAfter: new Date(parsed.data.updatedAfter) }
            : {}),
          ...(parsed.data.pageToken !== undefined ? { pageToken: parsed.data.pageToken } : {}),
          ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        });
        reply.code(200).send({
          records: result.records.map(toItemResponse),
          nextCursor: result.nextCursor ? result.nextCursor.toISOString() : null,
          nextPageToken: result.nextPageToken,
        });
        return reply;
      } catch (err) {
        if (err instanceof ItemError) {
          handleItemError(reply, err);
          return reply;
        }
        throw err;
      }
    });

    // GET /v1/catalog/items/:itemId
    app.get<{ Params: { itemId: string } }>(
      "/items/:itemId",
      { preHandler: gatedPreHandler },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        if (!UUID_RE.test(req.params.itemId)) {
          sendError(reply, 404, "item_not_found", `No item ${req.params.itemId}.`);
          return reply;
        }
        try {
          const row = await deps.items.get({
            merchantId: principal.merchantId,
            id: req.params.itemId,
          });
          reply.code(200).send(toItemResponse(row));
          return reply;
        } catch (err) {
          if (err instanceof ItemError) {
            handleItemError(reply, err);
            return reply;
          }
          throw err;
        }
      },
    );

    // POST /v1/catalog/items
    app.post("/items", { preHandler: gatedPreHandler }, async (req, reply) => {
      const principal = requireStaffPrincipal(req, reply);
      if (!principal) return reply;
      const parsed = itemCreateRequest.safeParse(req.body);
      if (!parsed.success) {
        sendError(reply, 422, "validation_error", "Invalid request body.", parsed.error.flatten());
        return reply;
      }
      try {
        const row = await deps.items.create({
          merchantId: principal.merchantId,
          code: parsed.data.code,
          name: parsed.data.name,
          priceIdr: parsed.data.priceIdr,
          uomId: parsed.data.uomId,
          ...(parsed.data.bomId !== undefined ? { bomId: parsed.data.bomId } : {}),
          ...(parsed.data.isStockTracked !== undefined
            ? { isStockTracked: parsed.data.isStockTracked }
            : {}),
          ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
        });
        reply.code(201).send(toItemResponse(row));
        return reply;
      } catch (err) {
        if (err instanceof ItemError) {
          handleItemError(reply, err);
          return reply;
        }
        throw err;
      }
    });

    // PATCH /v1/catalog/items/:itemId
    app.patch<{ Params: { itemId: string } }>(
      "/items/:itemId",
      { preHandler: gatedPreHandler },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        if (!UUID_RE.test(req.params.itemId)) {
          sendError(reply, 404, "item_not_found", `No item ${req.params.itemId}.`);
          return reply;
        }
        const parsed = itemUpdateRequest.safeParse(req.body);
        if (!parsed.success) {
          sendError(
            reply,
            422,
            "validation_error",
            "Invalid request body.",
            parsed.error.flatten(),
          );
          return reply;
        }
        try {
          const patch: {
            code?: string;
            name?: string;
            priceIdr?: number;
            uomId?: string;
            bomId?: string | null;
            isStockTracked?: boolean;
            isActive?: boolean;
          } = {};
          if (parsed.data.code !== undefined) patch.code = parsed.data.code;
          if (parsed.data.name !== undefined) patch.name = parsed.data.name;
          if (parsed.data.priceIdr !== undefined) patch.priceIdr = parsed.data.priceIdr;
          if (parsed.data.uomId !== undefined) patch.uomId = parsed.data.uomId;
          if (parsed.data.bomId !== undefined) patch.bomId = parsed.data.bomId;
          if (parsed.data.isStockTracked !== undefined)
            patch.isStockTracked = parsed.data.isStockTracked;
          if (parsed.data.isActive !== undefined) patch.isActive = parsed.data.isActive;
          const row = await deps.items.update({
            merchantId: principal.merchantId,
            id: req.params.itemId,
            patch,
          });
          reply.code(200).send(toItemResponse(row));
          return reply;
        } catch (err) {
          if (err instanceof ItemError) {
            handleItemError(reply, err);
            return reply;
          }
          throw err;
        }
      },
    );

    // DELETE /v1/catalog/items/:itemId — soft delete via is_active=false
    app.delete<{ Params: { itemId: string } }>(
      "/items/:itemId",
      { preHandler: gatedPreHandler },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        if (!UUID_RE.test(req.params.itemId)) {
          sendError(reply, 404, "item_not_found", `No item ${req.params.itemId}.`);
          return reply;
        }
        try {
          await deps.items.softDelete({
            merchantId: principal.merchantId,
            id: req.params.itemId,
          });
          reply.code(204).send();
          return reply;
        } catch (err) {
          if (err instanceof ItemError) {
            handleItemError(reply, err);
            return reply;
          }
          throw err;
        }
      },
    );

    // Other catalog placeholders remain 501 until their issues land.
    app.get("/boms", async (req, reply) => notImplemented(req, reply));
    app.get("/uoms", async (req, reply) => notImplemented(req, reply));
    app.get("/modifiers", async (req, reply) => notImplemented(req, reply));
  };
}
