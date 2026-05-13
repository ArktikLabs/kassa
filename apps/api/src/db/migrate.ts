import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, type Database, type DatabaseHandle } from "./client.js";

/**
 * Absolute path to the generated migrations folder. Resolved via
 * `import.meta.url` so the path works both from `dist/` (after
 * `pnpm build`) and from `src/` under `tsx watch`.
 */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "migrations");
}

/**
 * Apply any pending migrations to the database at `db`. Idempotent — Drizzle's
 * migrator keeps a `drizzle.__drizzle_migrations` table and only runs the new
 * ones. Safe to call on every boot.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

/**
 * Convenience wrapper used by the `pnpm db:migrate` script and by the Fly
 * `release_command`: open a connection, run all pending migrations, close.
 *
 * Exits non-zero on failure so the deploy aborts before any new code starts
 * serving traffic against a stale schema.
 */
export async function runMigrationsFromUrl(url: string, ssl: boolean): Promise<void> {
  const handle: DatabaseHandle = createDatabase({ url, ssl });
  try {
    await runMigrations(handle.db);
  } finally {
    await handle.close();
  }
}

// Direct-execute entry point. `pnpm --filter @kassa/api db:migrate` runs this
// file via `tsx`, and Fly's `release_command` runs it against the compiled JS.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set; aborting migrate.");
    process.exit(1);
  }
  const ssl = process.env.DATABASE_SSL !== "false";
  await runMigrationsFromUrl(url, ssl);
  // biome-ignore lint/suspicious/noConsole: release_command runs this script without a logger; the Fly job log is the operator's only signal that migrations completed.
  console.log("migrations applied");
}

const invokedPath = process.argv[1] ?? "";
const thisFilePath = fileURLToPath(import.meta.url);
if (
  invokedPath === thisFilePath ||
  invokedPath.endsWith("/db/migrate.js") ||
  invokedPath.endsWith("/db/migrate.ts")
) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("migrate failed", err);
    process.exit(1);
  });
}
