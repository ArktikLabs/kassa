import { defineConfig } from "drizzle-kit";

/*
 * Drizzle Kit configuration for @kassa/api.
 *
 * - Schema source is every file under `src/db/schema/` (one file per aggregate,
 *   per ARCHITECTURE.md §2.2).
 * - Generated SQL lands in `src/db/migrations/` and is committed to the repo;
 *   the migration runner (`src/db/migrate.ts`) applies it at boot / in CI.
 * - `DATABASE_URL` is only required when running `drizzle-kit push`/`studio`;
 *   `drizzle-kit generate` works without a live database.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*.ts",
  out: "./src/db/migrations",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://unused@localhost/unused",
  },
});
