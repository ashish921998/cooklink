import { serve } from '@hono/node-server';
import { createDatabase } from '@cooklink/db';
import { createApp } from './app.js';
import { assertValidServerConfig, parseServerConfig } from './config.js';
import { createLogger } from './logger.js';
import { initObservability, flushObservability } from './observability.js';
import { createScheduler } from './scheduler.js';
import { createMediaStore } from './media.js';
import {
  createDatabaseConfirmationStore,
  createDatabaseOAuthCallbackStore,
  createDatabasePendingOAuthStore,
  createDatabaseProductCacheStore,
} from './flow-state.js';
import { createOrderTracker } from './order-tracking.js';
import { createDatabaseSwiggyTokenStore, createSwiggyProvider } from './provider-swiggy.js';

// Fail fast, loudly, and secret-free on inconsistent configuration (issue 13):
// an intended live deployment must never silently fall back to the stub
// provider, and a real provider requires a valid token encryption key.
assertValidServerConfig(process.env);

const port = Number(process.env.PORT ?? 3000);
const db = createDatabase(process.env.DATABASE_URL);
const log = createLogger();
const media = createMediaStore();
// One parsed/normalized configuration: these are exactly the trimmed values
// `assertValidServerConfig` checked, so runtime behavior cannot diverge from
// what was validated (e.g. by reading an untrimmed raw value here).
const { swiggyMode, orderingEnabled } = parseServerConfig(process.env);
const encryptionKey =
  swiggyMode === 'stub' ? undefined : requiredEnv('SWIGGY_TOKEN_ENCRYPTION_KEY');
const provider =
  swiggyMode === 'stub'
    ? undefined
    : createSwiggyProvider({
        tokenStore: createDatabaseSwiggyTokenStore(db, encryptionKey!),
        // Durable flow state: OAuth handshakes, browser-callback routing, and
        // the recent-product cache survive restarts and work across instances.
        pendingOAuthStore: createDatabasePendingOAuthStore(db, encryptionKey!),
        productCache: createDatabaseProductCacheStore(db),
        baseUrl:
          process.env.SWIGGY_MCP_BASE_URL ??
          (swiggyMode === 'staging' ? 'https://mcp-staging.swiggy.com' : 'https://mcp.swiggy.com'),
      });
const app = createApp(db, {
  media,
  log,
  provider,
  orderingEnabled,
  // Durable, single-use, membership-bound checkout confirmations.
  confirmations: createDatabaseConfirmationStore(db),
  oauthCallbacks: createDatabaseOAuthCallbackStore(db),
});

// Structured error capture (issue 07, AC#19). No-op without SENTRY_DSN.
initObservability();

// Scheduled jobs run inside the always-on server process (issue 07, AC#17).
// The order-tracking poll is feature-gated: it polls only when real ordering
// is enabled AND a real provider is configured; otherwise it is a no-op.
const scheduler = createScheduler(
  db,
  {
    media,
    orderTracker: createOrderTracker({ db, provider, orderingEnabled, log }),
  },
  log,
);
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
