import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Create a Drizzle MySQL client. The connection URL points at PlanetScale
 * (Mumbai) in production; locally any MySQL 8 works. There is no RLS — all
 * household scoping happens in the application server.
 */
export function createDatabase(url: string | undefined): Database {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to connect to MySQL.');
  }
  const pool = mysql.createPool({
    uri: connectionString,
    connectionLimit: 10,
    multipleStatements: false,
  });
  // `as never` sidesteps a version-pinned peer type mismatch between the
  // installed mysql2 types and drizzle-orm's driver types; the pool is
  // structurally correct at runtime.
  return drizzle(pool as never, { schema, mode: 'default' });
}
