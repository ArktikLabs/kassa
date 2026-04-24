import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

/*
 * Fresh-DB migration test. Gated on `DATABASE_URL` so the default
 * `pnpm --filter @kassa/api test` run stays green on machines without a
 * Postgres installed; CI / Neon branch deploys set the env var and this
 * suite asserts:
 *
 *   1. `runMigrations` applies the initial schema to an empty database
 *      without error.
 *   2. Every expected v0 table is present afterwards.
 *   3. Re-running the migration is a no-op (Drizzle's migrator is idempotent).
 *
 * The test pointers at whatever DB `DATABASE_URL` resolves to — it does not
 * create or drop the database itself. Point it at a disposable staging DB
 * or a per-job Neon branch; never your working DB. `TRUNCATE` on the
 * Drizzle bookkeeping table is the only destructive write we do, and it
 * only happens when `KASA_TEST_RESET_MIGRATIONS=1` is explicitly set.
 */

const EXPECTED_TABLES = [
  "bom_components",
  "boms",
  "devices",
  "end_of_day",
  "enrolment_codes",
  "items",
  "merchants",
  "modifiers",
  "outlets",
  "sale_items",
  "sales",
  "staff",
  "stock_ledger",
  "stock_snapshots",
  "sync_log",
  "tenders",
  "transaction_events",
  "uoms",
] as const;

const databaseUrl = process.env.DATABASE_URL;
const ssl = process.env.DATABASE_SSL !== "false";
const runIfDb = databaseUrl ? describe : describe.skip;

runIfDb("db/migrate (fresh DB)", () => {
  it("applies the initial schema and creates every expected v0 table", async () => {
    if (!databaseUrl) throw new Error("unreachable: guarded by runIfDb");
    const handle = createDatabase({ url: databaseUrl, ssl });
    try {
      await runMigrations(handle.db);

      const { rows } = await handle.pool.query<{ table_name: string }>(
        `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE'`,
      );
      const actual = new Set(rows.map((r) => r.table_name));

      for (const expected of EXPECTED_TABLES) {
        expect(actual, `expected table ${expected}`).toContain(expected);
      }

      // Second run must not throw — migrations are idempotent.
      await runMigrations(handle.db);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
