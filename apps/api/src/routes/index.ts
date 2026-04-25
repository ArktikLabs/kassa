import type { FastifyInstance } from "fastify";
import { authRoutes, type AuthRouteDeps } from "./auth.js";
import { catalogRoutes, type CatalogRouteDeps } from "./catalog.js";
import { outletsRoutes } from "./outlets.js";
import { stockRoutes } from "./stock.js";
import { salesRoutes, type SalesRouteDeps } from "./sales.js";
import { paymentsRoutes } from "./payments.js";
import { eodRoutes, type EodRouteDeps } from "./eod.js";

export interface V1RouteDeps {
  auth: AuthRouteDeps;
  sales: SalesRouteDeps;
  eod: EodRouteDeps;
  catalog: CatalogRouteDeps;
}

export async function registerV1Routes(app: FastifyInstance, deps: V1RouteDeps): Promise<void> {
  await app.register(authRoutes(deps.auth), { prefix: "/auth" });
  await app.register(catalogRoutes(deps.catalog), { prefix: "/catalog" });
  await app.register(outletsRoutes, { prefix: "/outlets" });
  await app.register(stockRoutes, { prefix: "/stock" });
  await app.register(salesRoutes(deps.sales), { prefix: "/sales" });
  await app.register(paymentsRoutes, { prefix: "/payments" });
  await app.register(eodRoutes(deps.eod), { prefix: "/eod" });
}
