import { serve } from '@hono/node-server';
import { createDatabase } from '@cooklink/db';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const db = createDatabase(process.env.DATABASE_URL);
const app = createApp(db);

serve({ fetch: app.fetch, port });
console.log(`Cooklink API listening on http://localhost:${port}`);
