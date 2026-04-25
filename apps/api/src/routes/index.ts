import type { FastifyInstance } from "fastify";
import { authRoutes, type AuthRouteDeps } from "./auth.js";
import { catalogRoutes, type CatalogRouteDeps } from "./catalog.js";
import { eodRoutes, type EodRouteDeps } from "./eod.js";
import { outletsRoutes } from "./outlets.js";
import { paymentsRoutes } from "./payments.js";
import { reconciliationRoutes, type ReconciliationRouteDeps } from "./reconciliation.js";
import { salesRoutes, type SalesRouteDeps } from "./sales.js";
import { stockRoutes, type StockRouteDeps } from "./stock.js";

export interface V1RouteDeps {
  auth: AuthRouteDeps;
  catalog: CatalogRouteDeps;
  sales: SalesRouteDeps;
  stock: StockRouteDeps;
  eod: EodRouteDeps;
  reconciliation: ReconciliationRouteDeps;
}

export async function registerV1Routes(app: FastifyInstance, deps: V1RouteDeps): Promise<void> {
  await app.register(authRoutes(deps.auth), { prefix: "/auth" });
  await app.register(catalogRoutes(deps.catalog), { prefix: "/catalog" });
  await app.register(outletsRoutes, { prefix: "/outlets" });
  await app.register(stockRoutes(deps.stock), { prefix: "/stock" });
  await app.register(salesRoutes(deps.sales), { prefix: "/sales" });
  await app.register(paymentsRoutes, { prefix: "/payments" });
  await app.register(eodRoutes(deps.eod), { prefix: "/eod" });
  await app.register(reconciliationRoutes(deps.reconciliation), {
    prefix: "/admin/reconciliation",
  });
}
