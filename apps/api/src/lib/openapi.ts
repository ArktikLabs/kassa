import type { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

// Re-export the wire-level error envelope from `@kassa/schemas` so routes can
// keep importing `errorBodySchema` / `notImplementedResponses` from this
// module while the canonical Zod definition lives in the shared package
// (KASA-179 contract gate).
export { errorBodySchema, notImplementedResponses, type ErrorBody } from "@kassa/schemas/errors";

/**
 * Tags used to group operations in the rendered Swagger UI. Keep in sync
 * with the route prefixes registered in `routes/index.ts`.
 */
export const openapiTags = [
  { name: "health", description: "Liveness probe used by uptime monitors." },
  { name: "auth", description: "Device enrolment and staff/PIN session endpoints." },
  { name: "catalog", description: "Items, BOMs, units of measure, and modifiers." },
  { name: "outlets", description: "Outlets configured under the merchant." },
  { name: "stock", description: "Per-outlet stock snapshots and ledger." },
  { name: "sales", description: "Sale creation, lookup, void, refund, and offline sync." },
  { name: "payments", description: "QRIS charge initiation and provider webhooks." },
  { name: "eod", description: "End-of-day close and reconciliation reports." },
  {
    name: "reconciliation",
    description: "Owner-only static-QRIS reconciliation pass and manual matches.",
  },
] as const;

export interface OpenapiOptions {
  /**
   * Where to mount Swagger UI. Defaults to `/docs`. The OpenAPI JSON spec
   * is always served at `${routePrefix}/json` by `@fastify/swagger-ui`.
   */
  routePrefix?: string;
}

/**
 * Registers `@fastify/swagger` (spec generation) and `@fastify/swagger-ui`
 * (rendered docs). Must be called before any route plugins so swagger can
 * see them.
 *
 * The OpenAPI version emitted is 3.1; we follow the tech-stack decision
 * (`docs/TECH-STACK.md` §5.4) to derive the spec from Zod schemas via
 * `fastify-type-provider-zod`'s `jsonSchemaTransform`.
 */
export async function registerOpenapi(
  app: FastifyInstance,
  options: OpenapiOptions = {},
): Promise<void> {
  const routePrefix = options.routePrefix ?? "/docs";
  const version = process.env.npm_package_version ?? "0.0.0";

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Kassa API",
        description:
          "Kassa back-office REST API. Most v0 endpoints are still scaffolded " +
          "and return HTTP 501 — see `apps/api/README.md` for the live status of " +
          "each route. The spec is generated from Zod schemas at boot.",
        version,
        license: { name: "AGPL-3.0-or-later" },
      },
      servers: [{ url: "http://localhost:3000", description: "Local dev server." }],
      tags: openapiTags as unknown as Array<{ name: string; description: string }>,
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix,
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
    staticCSP: true,
  });
}
