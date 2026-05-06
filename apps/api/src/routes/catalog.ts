import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  itemCreateRequest,
  itemListQuery,
  itemUpdateRequest,
  type ItemCreateRequest,
  type ItemListQuery,
  type ItemUpdateRequest,
} from "@kassa/schemas/catalog";
import {
  bomPullResponse,
  itemPullResponse,
  itemRecord,
  referencePullQuery,
  uomPullResponse,
  type ReferencePullQuery,
} from "@kassa/schemas";
import { notImplemented, sendError } from "../lib/errors.js";
import { errorBodySchema, notImplementedResponses } from "../lib/openapi.js";
import { validate } from "../lib/validate.js";
import { makeMerchantScopedStaffPreHandler } from "../auth/staff-bootstrap.js";
import {
  BomError,
  type BomsService,
  ItemError,
  type ItemsService,
  UomError,
  type UomsService,
  toBomResponse,
  toItemResponse,
  toUomResponse,
} from "../services/catalog/index.js";

export interface CatalogRouteDeps {
  items: ItemsService;
  boms: BomsService;
  uoms: UomsService;
  /**
   * Bootstrap window only. KASA-25 replaces this with the real staff session
   * preHandler; until then the CRUD write paths require a staff bootstrap
   * token + `X-Staff-Merchant-Id`. Reads accept any staff role; writes are
   * restricted to `owner`/`manager` per the RBAC matrix in
   * ARCHITECTURE.md §4 (KASA-26).
   */
  staffBootstrapToken?: string;
}

/**
 * Roles allowed to mutate the catalog. `cashier` and `read_only` get a 403
 * from the staff-bootstrap preHandler so a counter-staff session that
 * leaks the bootstrap token can't change prices or item availability.
 */
const CATALOG_WRITE_ROLES = ["owner", "manager"] as const;

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
    const requireStaffRead = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken)
      : null;
    const requireStaffWrite = deps.staffBootstrapToken
      ? makeMerchantScopedStaffPreHandler(deps.staffBootstrapToken, {
          allowedRoles: CATALOG_WRITE_ROLES,
        })
      : null;

    const makeGate = (handler: typeof requireStaffRead) => {
      if (handler) return handler;
      return async (_req: FastifyRequest, reply: FastifyReply) => {
        sendError(
          reply,
          503,
          "staff_bootstrap_disabled",
          "Set STAFF_BOOTSTRAP_TOKEN to enable catalog CRUD until KASA-25 ships staff sessions.",
        );
        return reply;
      };
    };
    const gatedPreHandler = makeGate(requireStaffRead);
    const gatedWritePreHandler = makeGate(requireStaffWrite);

    // GET /v1/catalog/items — merchant-scoped delta pull.
    app.get<{ Querystring: ItemListQuery }>(
      "/items",
      {
        schema: {
          tags: ["catalog"],
          summary: "Pull items (delta)",
          description:
            "Merchant-scoped delta pull. `updatedAfter` is the cursor returned " +
            "by the previous response (`nextCursor`); `pageToken` is the opaque " +
            "within-window page key. Body / query validation is handled by the " +
            "`validate()` preHandler and surfaces as 422 `validation_error`.",
          response: {
            200: itemPullResponse,
            400: errorBodySchema,
            401: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedPreHandler, validate({ query: itemListQuery })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        try {
          const result = await deps.items.list({
            merchantId: principal.merchantId,
            ...(req.query.updatedAfter !== undefined
              ? { updatedAfter: new Date(req.query.updatedAfter) }
              : {}),
            ...(req.query.pageToken !== undefined ? { pageToken: req.query.pageToken } : {}),
            ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
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
      },
    );

    // GET /v1/catalog/items/:itemId
    app.get<{ Params: { itemId: string } }>(
      "/items/:itemId",
      {
        schema: {
          tags: ["catalog"],
          summary: "Get one item",
          description:
            "Returns the canonical item record. Non-UUID `itemId` collapses to " +
            "404 `item_not_found` to keep the response shape uniform.",
          response: {
            200: itemRecord,
            401: errorBodySchema,
            404: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: gatedPreHandler,
      },
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

    // POST /v1/catalog/items — owner/manager only (KASA-26).
    app.post<{ Body: ItemCreateRequest }>(
      "/items",
      {
        schema: {
          tags: ["catalog"],
          summary: "Create an item",
          description:
            "Owner/manager-only. Cashier/read-only sessions get 403. Returns " +
            "the persisted item record. 409 `item_code_conflict` when `code` " +
            "collides with an existing item under the same merchant.",
          response: {
            201: itemRecord,
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            409: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedWritePreHandler, validate({ body: itemCreateRequest })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        try {
          const row = await deps.items.create({
            merchantId: principal.merchantId,
            code: req.body.code,
            name: req.body.name,
            priceIdr: req.body.priceIdr,
            uomId: req.body.uomId,
            ...(req.body.bomId !== undefined ? { bomId: req.body.bomId } : {}),
            ...(req.body.isStockTracked !== undefined
              ? { isStockTracked: req.body.isStockTracked }
              : {}),
            ...(req.body.taxRate !== undefined ? { taxRate: req.body.taxRate } : {}),
            ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {}),
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
      },
    );

    // PATCH /v1/catalog/items/:itemId — owner/manager only (KASA-26).
    app.patch<{ Params: { itemId: string }; Body: ItemUpdateRequest }>(
      "/items/:itemId",
      {
        schema: {
          tags: ["catalog"],
          summary: "Update an item",
          description:
            "Owner/manager-only. Empty body is rejected with 422 since " +
            "nothing-to-do is treated as a client error.",
          response: {
            200: itemRecord,
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            409: errorBodySchema,
            422: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: [gatedWritePreHandler, validate({ body: itemUpdateRequest })],
      },
      async (req, reply) => {
        const principal = requireStaffPrincipal(req, reply);
        if (!principal) return reply;
        if (!UUID_RE.test(req.params.itemId)) {
          sendError(reply, 404, "item_not_found", `No item ${req.params.itemId}.`);
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
            taxRate?: number;
            isActive?: boolean;
          } = {};
          if (req.body.code !== undefined) patch.code = req.body.code;
          if (req.body.name !== undefined) patch.name = req.body.name;
          if (req.body.priceIdr !== undefined) patch.priceIdr = req.body.priceIdr;
          if (req.body.uomId !== undefined) patch.uomId = req.body.uomId;
          if (req.body.bomId !== undefined) patch.bomId = req.body.bomId;
          if (req.body.isStockTracked !== undefined) patch.isStockTracked = req.body.isStockTracked;
          if (req.body.taxRate !== undefined) patch.taxRate = req.body.taxRate;
          if (req.body.isActive !== undefined) patch.isActive = req.body.isActive;
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

    // DELETE /v1/catalog/items/:itemId — soft delete via is_active=false.
    // Owner/manager only (KASA-26).
    app.delete<{ Params: { itemId: string } }>(
      "/items/:itemId",
      {
        schema: {
          tags: ["catalog"],
          summary: "Soft-delete an item",
          description:
            "Owner/manager-only. Flips `isActive` to false; the row stays in " +
            "the delta-pull stream so offline clients can reconcile.",
          response: {
            401: errorBodySchema,
            403: errorBodySchema,
            404: errorBodySchema,
            503: errorBodySchema,
          },
        },
        preHandler: gatedWritePreHandler,
      },
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

    // GET /v1/catalog/boms — merchant-scoped delta pull (KASA-122).
    app.get<{ Querystring: ReferencePullQuery }>(
      "/boms",
      {
        schema: {
          tags: ["catalog"],
          summary: "Pull BOMs (delta)",
          description:
            "Merchant-scoped delta pull of bill-of-materials records. Same " +
            "envelope as `GET /items` — see that endpoint for cursor / " +
            "page-token semantics.",
          response: {
            200: bomPullResponse,
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
          const result = await deps.boms.list({
            merchantId: principal.merchantId,
            ...(req.query.updatedAfter !== undefined
              ? { updatedAfter: new Date(req.query.updatedAfter) }
              : {}),
            ...(req.query.pageToken !== undefined ? { pageToken: req.query.pageToken } : {}),
            ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
          });
          reply.code(200).send({
            records: result.records.map(toBomResponse),
            nextCursor: result.nextCursor ? result.nextCursor.toISOString() : null,
            nextPageToken: result.nextPageToken,
          });
          return reply;
        } catch (err) {
          if (err instanceof BomError && err.code === "invalid_page_token") {
            sendError(reply, 400, "invalid_page_token", err.message);
            return reply;
          }
          throw err;
        }
      },
    );

    // GET /v1/catalog/uoms — merchant-scoped delta pull (KASA-122).
    app.get<{ Querystring: ReferencePullQuery }>(
      "/uoms",
      {
        schema: {
          tags: ["catalog"],
          summary: "Pull units of measure (delta)",
          description:
            "Merchant-scoped delta pull of UoM records. Same envelope as the " +
            "other catalog pull endpoints.",
          response: {
            200: uomPullResponse,
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
          const result = await deps.uoms.list({
            merchantId: principal.merchantId,
            ...(req.query.updatedAfter !== undefined
              ? { updatedAfter: new Date(req.query.updatedAfter) }
              : {}),
            ...(req.query.pageToken !== undefined ? { pageToken: req.query.pageToken } : {}),
            ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
          });
          reply.code(200).send({
            records: result.records.map(toUomResponse),
            nextCursor: result.nextCursor ? result.nextCursor.toISOString() : null,
            nextPageToken: result.nextPageToken,
          });
          return reply;
        } catch (err) {
          if (err instanceof UomError && err.code === "invalid_page_token") {
            sendError(reply, 400, "invalid_page_token", err.message);
            return reply;
          }
          throw err;
        }
      },
    );

    app.get(
      "/modifiers",
      {
        schema: {
          tags: ["catalog"],
          summary: "Pull modifiers (not implemented)",
          description: "Reserved for the modifiers delta pull. Returns 501 until the slice lands.",
          response: notImplementedResponses,
        },
      },
      async (req, reply) => notImplemented(req, reply),
    );
  };
}
