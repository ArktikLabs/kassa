import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  stockPullResponse,
  type StockPullResponse,
  type StockSnapshotRecord,
} from "@kassa/schemas";
import { notImplemented, sendError } from "../lib/errors.js";
import { validate } from "../lib/validate.js";
import type { SalesRepository } from "../services/sales/index.js";

export interface StockRouteDeps {
  repository: SalesRepository;
  resolveMerchantId: (req: { headers: Record<string, unknown> }) => string | null;
  now?: () => Date;
}

const stockSnapshotQuery = z
  .object({
    outlet: z.string().min(1),
  })
  .strict();
type StockSnapshotQuery = z.infer<typeof stockSnapshotQuery>;

export function stockRoutes(deps: StockRouteDeps) {
  const now = deps.now ?? (() => new Date());
  return async function register(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: StockSnapshotQuery }>(
      "/snapshot",
      { preHandler: validate({ query: stockSnapshotQuery }) },
      async (req, reply) => {
        const merchantId = deps.resolveMerchantId(req);
        if (!merchantId) {
          sendError(reply, 401, "unauthorized", "Merchant context is required.");
          return reply;
        }
        const outletId = req.query.outlet;
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
      },
    );
    app.get("/ledger", async (req, reply) => notImplemented(req, reply));
  };
}
