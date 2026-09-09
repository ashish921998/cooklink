import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.js';

/**
 * Apply Drizzle migrations to the configured PostgreSQL database.
 *   pnpm db:migrate
 */
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const db = drizzle(client, { schema });
  console.log('Applying migrations…');
  await migrate(db, { migrationsFolder: './migrations' });
  console.log('Done.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
