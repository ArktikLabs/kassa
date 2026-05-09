import type { FastifyInstance } from "fastify";
import type { DeviceAuthPreHandler } from "../auth/device-auth.js";
import { authRoutes, type AuthRouteDeps } from "./auth.js";
import { catalogRoutes, type CatalogRouteDeps } from "./catalog.js";
import { eodRoutes, type EodRouteDeps } from "./eod.js";
import { merchantRoutes, type MerchantRouteDeps } from "./merchant.js";
import { outletsRoutes, type OutletsRouteDeps } from "./outlets.js";
import { paymentsRoutes } from "./payments.js";
import { reconciliationRoutes, type ReconciliationRouteDeps } from "./reconciliation.js";
import { salesRoutes, type SalesRouteDeps } from "./sales.js";
import { stockRoutes, type StockRouteDeps } from "./stock.js";

export interface V1RouteDeps {
  /**
   * Device-auth gate produced by `makeDeviceAuthPreHandler`. Routes attach
   * it via the route-level `preHandler` config so each endpoint declares
   * its own auth posture.
   */
  requireDevice: DeviceAuthPreHandler;
  auth: AuthRouteDeps;
  catalog: CatalogRouteDeps;
  merchant: MerchantRouteDeps;
  outlets: OutletsRouteDeps;
  sales: SalesRouteDeps;
  stock: StockRouteDeps;
  eod: EodRouteDeps;
  reconciliation: ReconciliationRouteDeps;
}

export async function registerV1Routes(app: FastifyInstance, deps: V1RouteDeps): Promise<void> {
  await app.register(authRoutes(deps.auth), { prefix: "/auth" });
  await app.register(catalogRoutes(deps.catalog), { prefix: "/catalog" });
  await app.register(merchantRoutes(deps.merchant), { prefix: "/merchant" });
  await app.register(outletsRoutes(deps.outlets), { prefix: "/outlets" });
  await app.register(stockRoutes(deps.stock), { prefix: "/stock" });
  await app.register(salesRoutes(deps.sales), { prefix: "/sales" });
  await app.register(paymentsRoutes(deps.requireDevice), { prefix: "/payments" });
  await app.register(eodRoutes(deps.eod), { prefix: "/eod" });
  await app.register(reconciliationRoutes(deps.reconciliation), {
    prefix: "/admin/reconciliation",
  });
}
