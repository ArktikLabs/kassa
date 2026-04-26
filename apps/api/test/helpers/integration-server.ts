import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { describe } from "vitest";
import { buildApp } from "../../src/app.js";
import { createDatabase, type Database, type DatabaseHandle } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  ItemsService,
  PgItemsRepository,
  BomsService,
  PgBomsRepository,
  UomsService,
  PgUomsRepository,
} from "../../src/services/catalog/index.js";
import { OutletsService, PgOutletsRepository } from "../../src/services/outlets/index.js";
import {
  EnrolmentService,
  InMemoryEnrolmentRepository,
} from "../../src/services/enrolment/index.js";

/**
 * Real-HTTP, real-Postgres integration harness for `apps/api` (KASA-28).
 *
 * Differences from the in-memory `app.inject` suites that already cover each
 * endpoint:
 *
 *  - Boots Fastify on an ephemeral port (`listen({ port: 0 })`) and exercises
 *    routes via `fetch`, so the test traverses the real HTTP stack — request
 *    parsing, route dispatch, response serialisation, error envelope.
 *  - Wires Postgres-backed repositories for the aggregates that have one
 *    (catalog items/boms/uoms, outlets) so the assertions actually round-trip
 *    through SQL. Aggregates without a Pg repo yet (sales, EOD, reconciliation,
 *    enrolment) keep their in-memory defaults; their HTTP-layer coverage stays
 *    in the existing `app.inject` suites.
 *  - `reset()` truncates every table between tests so each case starts from
 *    a known empty schema (KASA-28 AC: "Use a test database that is reset
 *    between runs").
 *
 * The suite is skipped via `runIfIntegration` when `KASA_INTEGRATION_DATABASE_URL`
 * is not set — a dedicated env var (rather than `DATABASE_URL`) so a developer
 * can never accidentally TRUNCATE their app DB by exporting the wrong URL.
 * CI provides a Postgres service container and sets the var so the suite
 * actually runs there.
 */

export const STAFF_TOKEN = "test-integration-staff-token-aaaaaaaaaa";

export interface IntegrationHarness {
  app: FastifyInstance;
  baseUrl: string;
  db: Database;
  database: DatabaseHandle;
  /**
   * TRUNCATE every test-relevant table in dependency-safe order via
   * `TRUNCATE ... CASCADE`. Bookkeeping tables (`drizzle.__drizzle_migrations`)
   * are left intact so we don't re-run migrations between tests.
   */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The integration suite TRUNCATEs every catalog/sales/outlets/etc. table on
 * every test, so it must never accidentally touch a non-test database. Gate on
 * a dedicated env var that callers must set explicitly — `DATABASE_URL` alone
 * is not enough, because it can point at the developer's app DB or a managed
 * service. CI sets `KASA_INTEGRATION_DATABASE_URL` against an ephemeral
 * Postgres service container.
 */
const databaseUrl = process.env.KASA_INTEGRATION_DATABASE_URL;
const ssl = process.env.KASA_INTEGRATION_DATABASE_SSL === "true";

/**
 * Tables truncated by `reset()`. The `CASCADE` lets a single statement clear
 * the FK web in any order; the `RESTART IDENTITY` wipes any seq counters in
 * case future tables add them. Migrations live in the `drizzle` schema so the
 * `public` truncate leaves them alone.
 */
const TRUNCATABLE_TABLES = [
  "transaction_events",
  "stock_snapshots",
  "stock_ledger",
  "tenders",
  "sale_items",
  "sales",
  "end_of_day",
  "sync_log",
  "bom_components",
  "boms",
  "items",
  "modifiers",
  "uoms",
  "devices",
  "enrolment_codes",
  "staff",
  "outlets",
  "merchants",
] as const;

/**
 * Mirror of vitest's `describe.skipIf` shape so suites can simply call
 * `runIfIntegration("...", () => { ... })` and stay green on machines without
 * Postgres. CI sets `DATABASE_URL` and the suite runs there.
 */
export const runIfIntegration = databaseUrl ? describe : describe.skip;

export async function startIntegrationServer(): Promise<IntegrationHarness> {
  if (!databaseUrl) {
    throw new Error("startIntegrationServer requires KASA_INTEGRATION_DATABASE_URL to be set.");
  }

  const database = createDatabase({ url: databaseUrl, ssl });
  await runMigrations(database.db);

  const itemsRepo = new PgItemsRepository(database.db);
  const itemsService = new ItemsService({ repository: itemsRepo });
  const bomsService = new BomsService({ repository: new PgBomsRepository(database.db) });
  const uomsService = new UomsService({ repository: new PgUomsRepository(database.db) });
  const outletsService = new OutletsService({
    repository: new PgOutletsRepository(database.db),
  });

  // Enrolment has no Pg repo yet; keep the in-memory default so the
  // device-auth wire-up in buildApp() stays coherent.
  const enrolmentRepo = new InMemoryEnrolmentRepository();
  const enrolmentService = new EnrolmentService({ repository: enrolmentRepo });

  const app = await buildApp({
    enrolment: { service: enrolmentService, staffBootstrapToken: STAFF_TOKEN },
    deviceAuth: { repository: enrolmentRepo },
    catalog: {
      items: itemsService,
      boms: bomsService,
      uoms: uomsService,
      staffBootstrapToken: STAFF_TOKEN,
    },
    outlets: { service: outletsService, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  await app.listen({ host: "127.0.0.1", port: 0 });

  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const harness: IntegrationHarness = {
    app,
    baseUrl,
    db: database.db,
    database,
    async reset() {
      const tables = TRUNCATABLE_TABLES.map((t) => `"public"."${t}"`).join(", ");
      await database.db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`));
    },
    async close() {
      await app.close();
      await database.close();
    },
  };
  return harness;
}

export interface SeededMerchant {
  id: string;
  name: string;
}

export async function seedMerchant(
  db: Database,
  partial: { id: string; name?: string },
): Promise<SeededMerchant> {
  const name = partial.name ?? "Test Merchant";
  await db.execute(
    sql`INSERT INTO merchants (id, name, timezone) VALUES (${partial.id}, ${name}, 'Asia/Jakarta')`,
  );
  return { id: partial.id, name };
}

export interface SeededOutlet {
  id: string;
  merchantId: string;
  code: string;
  name: string;
}

export async function seedOutlet(
  db: Database,
  partial: { id: string; merchantId: string; code: string; name?: string },
): Promise<SeededOutlet> {
  const name = partial.name ?? `Outlet ${partial.code}`;
  await db.execute(
    sql`INSERT INTO outlets (id, merchant_id, code, name, timezone)
        VALUES (${partial.id}, ${partial.merchantId}, ${partial.code}, ${name}, 'Asia/Jakarta')`,
  );
  return { id: partial.id, merchantId: partial.merchantId, code: partial.code, name };
}

export interface SeededUom {
  id: string;
  merchantId: string;
  code: string;
  name: string;
}

export async function seedUom(
  db: Database,
  partial: { id: string; merchantId: string; code: string; name?: string },
): Promise<SeededUom> {
  const name = partial.name ?? partial.code;
  await db.execute(
    sql`INSERT INTO uoms (id, merchant_id, code, name)
        VALUES (${partial.id}, ${partial.merchantId}, ${partial.code}, ${name})`,
  );
  return { id: partial.id, merchantId: partial.merchantId, code: partial.code, name };
}

/**
 * Inserts an item directly via SQL so list endpoints have something to return
 * without going through the create handler (which is itself under test). Use
 * the create-item endpoint when the test is *about* item creation.
 */
export async function seedItem(
  db: Database,
  partial: {
    id: string;
    merchantId: string;
    code: string;
    name: string;
    priceIdr: number;
    uomId: string;
  },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO items (id, merchant_id, code, name, price_idr, uom_id, is_stock_tracked, allow_negative, is_active)
        VALUES (${partial.id}, ${partial.merchantId}, ${partial.code}, ${partial.name},
                ${partial.priceIdr}, ${partial.uomId}, true, false, true)`,
  );
}

export function staffHeaders(
  merchantId: string,
  staffUserId: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": staffUserId,
    "x-staff-merchant-id": merchantId,
    "x-staff-role": "owner",
    ...overrides,
  };
}
