import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Create a Drizzle PostgreSQL client. The connection URL points at
 * PlanetScale Postgres (Mumbai) in production; locally any Postgres 14+
 * works. There is no RLS — all household scoping happens in the application
 * server.
 *
 * When `PGBOUNCER=true`, prepared statements are disabled to avoid conflicts
 * with PgBouncer's transaction-mode pooling (PlanetScale recommends the
 * PgBouncer port 6432 for normal application traffic; use the direct port
 * only for migrations that require session-level behavior).
 */
export function createDatabase(url: string | undefined): Database {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to connect to PostgreSQL.');
  }
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    allowExitOnIdle: true,
    ...(process.env.PGBOUNCER === 'true' ? { prepare: false } : {}),
  });
  return drizzle(pool, { schema });
}
