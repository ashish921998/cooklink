import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config. The schema is PostgreSQL (PlanetScale Postgres,
 * Mumbai). Migrations are emitted to `./migrations`. No row-level security —
 * authorization is enforced in the application server (issue 07, AC#6).
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '********************************/cooklink',
  },
  strict: true,
  verbose: true,
});
