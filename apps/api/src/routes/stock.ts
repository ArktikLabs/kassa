import type { FastifyInstance } from "fastify";
import {
  stockPullResponse,
  type StockPullResponse,
  type StockSnapshotRecord,
} from "@kassa/schemas";
import { notImplemented, sendError } from "../lib/errors.js";
import type { SalesRepository } from "../services/sales/index.js";

export interface StockRouteDeps {
  repository: SalesRepository;
  resolveMerchantId: (req: { headers: Record<string, unknown> }) => string | null;
  now?: () => Date;
}

export function stockRoutes(deps: StockRouteDeps) {
  const now = deps.now ?? (() => new Date());
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/snapshot", async (req, reply) => {
      const merchantId = deps.resolveMerchantId(req);
      if (!merchantId) {
        sendError(reply, 401, "unauthorized", "Merchant context is required.");
        return reply;
      }
      const outletId = readOutletQuery(req.query);
      if (!outletId) {
        sendError(reply, 400, "bad_request", "Query parameter `outlet` is required.");
        return reply;
      }
      const outlet = await deps.repository.findOutlet(merchantId, outletId);
      if (!outlet) {
        sendError(reply, 404, "outlet_not_found", `Outlet ${outletId} is not registered.`);
        return reply;
      }
      const onHand = await deps.repository.allOnHandForOutlet(outletId);
      const updatedAt = now().toISOString();
      const records: StockSnapshotRecord[] = [...onHand.entries()].map(([itemId, qty]) => ({
        outletId,
        itemId,
        onHand: qty,
        updatedAt,
      }));
      const body: StockPullResponse = stockPullResponse.parse({
        records,
        nextCursor: updatedAt,
        nextPageToken: null,
      });
      reply.send(body);
      return reply;
    });
    app.get("/ledger", async (req, reply) => notImplemented(req, reply));
  };
}

function readOutletQuery(query: unknown): string | null {
  if (!query || typeof query !== "object") return null;
  const value = (query as { outlet?: unknown }).outlet;
  return typeof value === "string" && value.length > 0 ? value : null;
}
