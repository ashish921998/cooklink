/**
 * The Cooklink API application: middleware wiring and route-module
 * registration.
 *
 * This file is deliberately thin. Every API surface lives in a concept-named
 * module under `src/routes/` (meal plan, invites, chat, grocery requests,
 * provider, cart, checkout, suggested cart, notifications) — search there for
 * behavior. `createApp` builds the shared {@link AppRouteContext} (db,
 * authorization, provider, media, push, logging), applies CORS + request
 * logging + auth, mounts `/health` and `/v1/me`, registers each route module,
 * and installs the global error handler.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  Authorization,
  AuthorizationDeniedError,
  type GroceryProvider,
  type PushDispatcher,
  type UserId,
} from '@cooklink/domain';
import type { Database } from '@cooklink/db';
import type { Logger } from 'pino';
import { authMiddleware, type AuthEnv } from './auth.js';
import { DrizzleAuthorizationLookup } from './household-auth.js';
import { createMediaStore, type MediaStore } from './media.js';
import { createTranscriptionService, type TranscriptionService } from './transcription.js';
import { createLogger, requestLogger, logAuthorizationDenied } from './logger.js';
import { captureError } from './observability.js';
import { createStubProvider } from './provider-stub.js';
import {
  createInMemoryConfirmationStore,
  type CheckoutConfirmationStore,
} from './checkout-confirmation-store.js';
import { NoopPushDispatcher } from './push-delivery.js';
import { registerHouseholdRoutes } from './routes/households.routes.js';
import { registerMealPlanRoutes } from './routes/meal-plan.routes.js';
import { registerInviteRoutes } from './routes/invites.routes.js';
import { registerChatRoutes } from './routes/chat.routes.js';
import { registerChatSuggestionRoutes } from './routes/chat-suggestions.routes.js';
import { registerGroceryRequestRoutes } from './routes/grocery-requests.routes.js';
import { registerGroceryProviderRoutes } from './routes/grocery-provider.routes.js';
import { registerGroceryCartRoutes } from './routes/grocery-cart.routes.js';
import { registerGroceryCheckoutRoutes } from './routes/grocery-checkout.routes.js';
import { registerSuggestedCartRoutes } from './routes/suggested-cart.routes.js';
import { registerNotificationRoutes } from './routes/notifications.routes.js';

export interface AppServices {
  media?: MediaStore;
  transcription?: TranscriptionService;
  /** Inject a logger (e.g. a silenced Pino instance in tests). */
  log?: Logger;
  /**
   * The Instamart/Swiggy grocery provider (issue 10). Defaults to a local
   * stub so the complete product-matching journey is testable without
   * production credentials (AC#8).
   */
  provider?: GroceryProvider;
  /**
   * A short-lived checkout confirmation store (issue 11, AC#1/AC#2). Defaults
   * to an in-memory store which is safe for V1 single-instance: a restart
   * invalidates outstanding confirmations (fail-closed) and the durable
   * idempotency key in PostgreSQL still prevents duplicate orders across restarts.
   */
  confirmations?: CheckoutConfirmationStore;
  /**
   * Feature gate for real ordering (issue 11, AC#9). Defaults to the
   * `COOKLINK_ORDERING_ENABLED` env var. When false, the checkout surface is
   * visibly disabled until Swiggy staging and production access are approved.
   */
  orderingEnabled?: boolean;
  /**
   * Push notification dispatcher (issue 12). Defaults to a no-op recording
   * dispatcher; production wires Expo/APNs/FCM. Failures from invalid tokens
   * are reported back so the server can retire them (AC#8).
   */
  pushDispatcher?: PushDispatcher;
}

export function createApp(db: Database, services?: AppServices) {
  const app = new Hono<AuthEnv>();
  const authorization = new Authorization(new DrizzleAuthorizationLookup(db));
  const media = services?.media ?? createMediaStore();
  const transcription = services?.transcription ?? createTranscriptionService();
  const log = services?.log ?? createLogger();
  const provider = services?.provider ?? createStubProvider();
  const confirmations = services?.confirmations ?? createInMemoryConfirmationStore();
  const swiggyOAuthCallbacks = new Map<
    string,
    { userId: UserId; appReturnUri: string; createdAt: number }
  >();
  /**
   * Issue 11, AC#9 — real ordering is visibly feature-gated until Swiggy
   * staging and production access are approved. Default to the env var.
   */
  const orderingEnabled =
    services?.orderingEnabled ?? process.env.COOKLINK_ORDERING_ENABLED === 'true';
  /**
   * Push notification dispatcher (issue 12). Defaults to a no-op recording
   * dispatcher in development; production injects an Expo/APNs/FCM adapter.
   */
  const pushDispatcher: PushDispatcher = services?.pushDispatcher ?? new NoopPushDispatcher();

  const ctx = {
    db,
    authorization,
    media,
    transcription,
    provider,
    confirmations,
    orderingEnabled,
    pushDispatcher,
    log,
    swiggyOAuthCallbacks,
  };

  app.use(
    '*',
    cors({
      origin: '*',
      allowHeaders: [
        'authorization',
        'content-type',
        'x-clerk-user-id',
        'x-cooklink-dev-phone',
        'x-cooklink-dev-name',
      ],
    }),
  );

  // Structured request logging covers every request, including /health
  // (issue 07, AC#19 — "every request logs user, Household, route, latency,
  // and status"). The middleware reads `authUser` after `await next()`, so it
  // still captures the authenticated user for /v1/* routes even though auth
  // runs deeper in the chain; /health logs with a null user.
  app.use('*', requestLogger(log));

  app.get('/health', (c) => c.json({ ok: true, service: 'cooklink-server' }));

  app.use('/v1/*', authMiddleware(db));

  app.get('/v1/me', (c) => c.json({ user: c.get('authUser') }));

  registerHouseholdRoutes(app, ctx);
  registerMealPlanRoutes(app, ctx);
  registerInviteRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerChatSuggestionRoutes(app, ctx);
  registerGroceryRequestRoutes(app, ctx);
  registerGroceryProviderRoutes(app, ctx);
  registerGroceryCartRoutes(app, ctx);
  registerGroceryCheckoutRoutes(app, ctx);
  registerSuggestedCartRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);

  app.onError((err, c) => {
    if (err instanceof AuthorizationDeniedError) {
      // Structured authorization-denial log (issue 07, AC#5 / AC#19). Denials
      // return 404 so a non-member cannot probe which Household ids exist.
      logAuthorizationDenied(log, {
        userId: c.get('authUser')?.id,
        householdId: c.req.param('householdId'),
        capability: err.detail.capability,
        message: err.message,
      });
      return c.json({ error: 'not_found' }, 404);
    }
    log.error({ msg: 'unhandled_error', err });
    captureError(err, {
      route: c.req.path,
      method: c.req.method,
      userId: c.get('authUser')?.id ?? null,
    });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
