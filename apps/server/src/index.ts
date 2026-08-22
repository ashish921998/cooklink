import { serve } from '@hono/node-server';
import { createDatabase } from '@cooklink/db';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { initObservability, flushObservability } from './observability.js';
import { createScheduler } from './scheduler.js';
import { createMediaStore } from './media.js';
import { createDatabaseSwiggyTokenStore, createSwiggyProvider } from './provider-swiggy.js';

const port = Number(process.env.PORT ?? 3000);
const db = createDatabase(process.env.DATABASE_URL);
const log = createLogger();
const media = createMediaStore();
const swiggyMode = process.env.COOKLINK_SWIGGY_MODE ?? 'stub';
const provider =
  swiggyMode === 'stub'
    ? undefined
    : createSwiggyProvider({
        tokenStore: createDatabaseSwiggyTokenStore(db, requiredEnv('SWIGGY_TOKEN_ENCRYPTION_KEY')),
        baseUrl:
          process.env.SWIGGY_MCP_BASE_URL ??
          (swiggyMode === 'staging' ? 'https://mcp-staging.swiggy.com' : 'https://mcp.swiggy.com'),
      });
const app = createApp(db, { media, log, provider });

// Structured error capture (issue 07, AC#19). No-op without SENTRY_DSN.
initObservability();

// Scheduled jobs run inside the always-on server process (issue 07, AC#17).
// The order-tracking poll is a no-op until real Swiggy ordering is enabled.
const scheduler = createScheduler(db, { media }, log);
scheduler.start();

serve({ fetch: app.fetch, port });
log.info({ msg: 'server.listening', url: `http://localhost:${port}` });
console.log(`Cooklink API listening on http://localhost:${port}`);

async function shutdown(signal: string): Promise<void> {
  log.info({ msg: 'server.shutdown', signal });
  scheduler.stop();
  await flushObservability();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when COOKLINK_SWIGGY_MODE is not stub.`);
  return value;
}
