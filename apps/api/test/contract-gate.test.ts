/**
 * Contract gate (KASA-179).
 *
 * Three assertions, one suite:
 *
 *   1. Static — no route file under `apps/api/src/routes/` (other than the
 *      explicitly-allowlisted `health.ts`) declares a top-level Zod schema.
 *      Inline `z.union([…])` composition over already-imported schemas is
 *      tolerated; `const xxx = z.<method>(…)` declarations are not.
 *
 *   2. Identity — every route's `schema.body | querystring | params |
 *      response[<code>]` Zod schema is reference-equal to a schema exported
 *      by `@kassa/schemas`. This catches the case where a route silently
 *      re-declares a wire shape inline instead of importing it.
 *
 *   3. Drift — the OpenAPI document rendered by Swagger is compared against
 *      a committed snapshot. Any schema-shape change (renamed field, new
 *      route, dropped status code) trips the test with refresh instructions.
 *      Refresh: `UPDATE_OPENAPI_SNAPSHOT=1 pnpm --filter @kassa/api test
 *      contract-gate`.
 *
 * The gate runs as part of `pnpm -r test`, which `ci.yml` already invokes.
 * The `Contract gate` step in `ci.yml` re-runs just this suite so a failure
 * surfaces with a named step in the GitHub UI.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import type { FastifyInstance, RouteOptions } from "fastify";
import { ZodType, ZodUnion } from "zod";

import * as schemasModule from "@kassa/schemas";
import * as authModule from "@kassa/schemas/auth";
import * as catalogModule from "@kassa/schemas/catalog";
import * as eodModule from "@kassa/schemas/eod";
import * as errorsModule from "@kassa/schemas/errors";
import * as paymentsModule from "@kassa/schemas/payments";
import * as reconciliationModule from "@kassa/schemas/reconciliation";

import { buildApp } from "../src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(__dirname, "../src/routes");
const SNAPSHOT_PATH = resolve(__dirname, "__contract__/openapi.snapshot.json");

/**
 * Routes that are allowed to declare their own inline Zod (the issue
 * description scoped `health` out: "health may be skipped").
 */
const STATIC_ALLOWED_ROUTES = new Set(["health.ts", "index.ts"]);

/**
 * Route URLs that may use inline Zod at runtime. Matches the static allowlist:
 * `/health` is the unversioned liveness probe; its schema is intentionally
 * route-local because external monitors should not need to track API versions.
 */
const RUNTIME_ALLOWED_URLS = new Set(["/health"]);

/**
 * Set of every Zod schema instance exported (directly or as part of a
 * record-of-schemas) by `@kassa/schemas`. We compare by reference identity:
 * routes that import from the package contribute the same instance, while
 * routes that re-declare an inline `z.<method>(...)` produce a fresh
 * instance that never appears in this set.
 */
const exportedSchemas = collectZods([
  schemasModule,
  authModule,
  catalogModule,
  eodModule,
  errorsModule,
  paymentsModule,
  reconciliationModule,
]);

function collectZods(modules: ReadonlyArray<Record<string, unknown>>): Set<ZodType> {
  const out = new Set<ZodType>();
  function walk(value: unknown): void {
    if (value instanceof ZodType) {
      out.add(value);
      // Walk union options so e.g. the (currently unused) idiom of an
      // exported `z.union([a, b])` still treats `a` and `b` as exported.
      if (value instanceof ZodUnion) {
        for (const opt of value.options) walk(opt);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v);
    }
  }
  for (const mod of modules) walk(mod);
  return out;
}

describe("contract gate (KASA-179)", () => {
  describe("1. Static — no inline Zod in route files", () => {
    it("forbids `const xxx = z.<method>(...)` outside the health allowlist", () => {
      const violations: string[] = [];
      for (const file of readdirSync(ROUTES_DIR)) {
        if (!file.endsWith(".ts")) continue;
        if (STATIC_ALLOWED_ROUTES.has(file)) continue;
        const source = readFileSync(resolve(ROUTES_DIR, file), "utf8");
        // Match `const|let <name> = z.<zodMethod>(`, optionally typed, with
        // any leading whitespace. Inline `z.union([...])` as an argument is
        // not bound to a name, so it slips through this regex by design.
        const re =
          /^\s*(?:export\s+)?(?:const|let)\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*z\.(?:object|array|enum|literal|union|string|number|boolean|date|tuple|record|map|set|bigint|nan|null|undefined|void|any|unknown|never|coerce)\s*[(.]/m;
        const m = re.exec(source);
        if (m) {
          const lineNumber = source.slice(0, m.index).split("\n").length;
          violations.push(`${file}:${lineNumber} — ${m[0].trim()}`);
        }
      }
      expect(
        violations,
        "Inline Zod schemas in route files. Move them into `packages/schemas/src/` " +
          "and import from `@kassa/schemas`. If the schema legitimately must stay " +
          "route-local, add the file to STATIC_ALLOWED_ROUTES with a comment.",
      ).toEqual([]);
    });
  });

  describe("2. Identity — route schemas are sourced from @kassa/schemas", () => {
    let captured: RouteOptions[];
    let app: FastifyInstance;

    beforeAll(async () => {
      captured = [];
      app = await buildApp({
        onCreate: (instance) => {
          instance.addHook("onRoute", (route) => {
            captured.push(route as RouteOptions);
          });
        },
      });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("every captured route has at least one schema entry", () => {
      // Sanity check: if buildApp ever stops registering schemas the rest
      // of the suite would pass trivially. This guards against a silent
      // regression there.
      const withSchema = captured.filter((r) => r.schema && Object.keys(r.schema).length > 0);
      expect(withSchema.length).toBeGreaterThan(10);
    });

    it("every Zod schema attached to a route is exported by @kassa/schemas", () => {
      const violations: string[] = [];

      for (const route of captured) {
        if (!route.schema) continue;
        if (RUNTIME_ALLOWED_URLS.has(route.url)) continue;
        const url = `${route.method} ${route.url}`;
        const schema = route.schema as Record<string, unknown>;

        for (const key of ["body", "querystring", "params"] as const) {
          assertExported(schema[key], `${url} schema.${key}`, violations);
        }

        const responses = schema.response as Record<string, unknown> | undefined;
        if (responses) {
          for (const [code, value] of Object.entries(responses)) {
            assertExported(value, `${url} schema.response.${code}`, violations);
          }
        }
      }

      expect(
        violations,
        "Routes registered Zod schemas not sourced from @kassa/schemas. " +
          "Move the schema into `packages/schemas/src/` and import the " +
          "exported instance.",
      ).toEqual([]);
    });

    function assertExported(value: unknown, label: string, sink: string[]): void {
      if (value === undefined) return;
      if (!(value instanceof ZodType)) return; // tolerate raw JSON-Schema literals
      if (value instanceof ZodUnion) {
        // `409: z.union([saleSubmitResponse, errorBodySchema])` — verify each
        // option is itself exported. Inline composition of exported parts is
        // allowed; bare inline `z.object` declarations are not.
        for (const opt of value.options) assertExported(opt, label, sink);
        return;
      }
      if (!exportedSchemas.has(value)) {
        sink.push(label);
      }
    }
  });

  describe("3. Drift — OpenAPI surface matches committed snapshot", () => {
    let app: FastifyInstance;
    let spec: unknown;

    beforeAll(async () => {
      app = await buildApp();
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/docs/json" });
      spec = res.json();
    });

    afterAll(async () => {
      await app.close();
    });

    it("the rendered OpenAPI document equals the committed snapshot", () => {
      const normalized = normalizeOpenapi(spec);
      const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

      if (process.env.UPDATE_OPENAPI_SNAPSHOT === "1") {
        mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
        writeFileSync(SNAPSHOT_PATH, serialized);
        // Pass the test on snapshot refresh; the diff lands in the PR for review.
        return;
      }

      if (!existsSync(SNAPSHOT_PATH)) {
        throw new Error(
          `Missing OpenAPI snapshot at ${SNAPSHOT_PATH}. Generate it with ` +
            `\`UPDATE_OPENAPI_SNAPSHOT=1 pnpm --filter @kassa/api test contract-gate\`.`,
        );
      }

      const expected = readFileSync(SNAPSHOT_PATH, "utf8");
      expect(
        serialized,
        "OpenAPI surface drifted from the committed snapshot. If this is " +
          "intentional (a route was added/changed), refresh the snapshot " +
          "with `UPDATE_OPENAPI_SNAPSHOT=1 pnpm --filter @kassa/api test " +
          "contract-gate` and commit the diff. If it's accidental drift " +
          "(an inline schema was added), fix the route to import from " +
          "`@kassa/schemas` instead.",
      ).toEqual(expected);
    });
  });
});

/**
 * Strip volatile fields from the OpenAPI document so the snapshot diff only
 * surfaces real wire-contract changes. We drop the `info.version` (sourced
 * from `process.env.npm_package_version`, which is `"0.0.0"` in CI but may
 * vary locally) and the `servers` block (the dev-only `localhost:3000`
 * URL changes per environment).
 */
function normalizeOpenapi(spec: unknown): unknown {
  if (!spec || typeof spec !== "object") return spec;
  const clone = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  if (clone.info && typeof clone.info === "object") {
    delete (clone.info as Record<string, unknown>).version;
  }
  delete clone.servers;
  return clone;
}
