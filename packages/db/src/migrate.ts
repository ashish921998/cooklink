import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import * as schema from './schema.js';

/**
 * Apply Drizzle migrations to the configured MySQL database.
 *   pnpm db:migrate
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const connection = await mysql.createConnection({ uri: url, multipleStatements: true });
  const db = drizzle(connection, { schema, mode: 'default' });
  console.log('Applying migrations…');
  await migrate(db, { migrationsFolder: './migrations' });
  console.log('Done.');
  await connection.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
