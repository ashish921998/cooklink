import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config. The schema is MySQL (PlanetScale, Mumbai). Migrations
 * are emitted to `./migrations`. No row-level security — authorization is
 * enforced in the application server (issue 07, AC#6).
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://root:root@localhost:3306/cooklink',
  },
  strict: true,
  verbose: true,
});
