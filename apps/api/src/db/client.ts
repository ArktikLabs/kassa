import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;
export type DatabasePool = pg.Pool;

export interface CreateDatabaseOptions {
  /** `postgres://...` connection URL; required. */
  url: string;
  /**
   * Max concurrent connections the web process will open. Kept low by default
   * because Fly's small machine tier has little memory to spare; scale up
   * alongside machine size.
   */
  max?: number;
  /**
   * Whether to request TLS. Neon and most managed Postgres require it. The
   * default `require` mode trusts the system CA bundle.
   */
  ssl?: boolean;
}

export interface DatabaseHandle {
  db: Database;
  pool: DatabasePool;
  close(): Promise<void>;
}

/**
 * Open a pooled Drizzle handle against Postgres. Call `close()` on shutdown
 * (the `index.ts` SIGINT/SIGTERM hook already exits the process, so this is
 * mostly for tests and for letting the pool's `end()` flush in-flight queries
 * cleanly).
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const pool = new Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    // Pool will close idle connections quickly on a serverless box.
    idleTimeoutMillis: 10_000,
    // Fail fast if the DB is unreachable; the caller retries boot.
    connectionTimeoutMillis: 5_000,
    ssl: options.ssl ? { rejectUnauthorized: true } : false,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
