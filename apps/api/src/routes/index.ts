import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth.js";
import { catalogRoutes } from "./catalog.js";
import { outletsRoutes } from "./outlets.js";
import { stockRoutes } from "./stock.js";
import { salesRoutes } from "./sales.js";
import { paymentsRoutes } from "./payments.js";
import { eodRoutes } from "./eod.js";

export async function registerV1Routes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(catalogRoutes, { prefix: "/catalog" });
  await app.register(outletsRoutes, { prefix: "/outlets" });
  await app.register(stockRoutes, { prefix: "/stock" });
  await app.register(salesRoutes, { prefix: "/sales" });
  await app.register(paymentsRoutes, { prefix: "/payments" });
  await app.register(eodRoutes, { prefix: "/eod" });
}
