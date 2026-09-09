import type { Database } from '@cooklink/db';
import type { Authorization, GroceryProvider, PushDispatcher } from '@cooklink/domain';
import type { Logger } from 'pino';
import type { MediaStore } from '../media.js';
import type { TranscriptionService } from '../transcription.js';
import type { CheckoutConfirmationStore } from '../checkout-confirmation-store.js';
import type { OAuthCallbackStore } from '../flow-state.js';

/**
 * The wiring every Cooklink API route module receives from `createApp`.
 *
 * One object so each `routes/*.routes.ts` module can be read — and searched —
 * as a self-contained concept (meal plan, invites, chat, checkout, …) that
 * declares exactly which collaborators it uses, instead of closing over a
 * 4,000-line app factory.
 */
export interface AppRouteContext {
  db: Database;
  /** Centralized household authorization (roles → capabilities). */
  authorization: Authorization;
  media: MediaStore;
  transcription: TranscriptionService;
  /** The Instamart/Swiggy grocery provider (issue 10). */
  provider: GroceryProvider;
  /** Short-lived checkout confirmation tokens (issue 11). */
  confirmations: CheckoutConfirmationStore;
  /** Feature gate for real ordering (issue 11, AC#9). */
  orderingEnabled: boolean;
  /** Push notification dispatcher (issue 12). */
  pushDispatcher: PushDispatcher;
  log: Logger;
  /**
   * Pending browser-OAuth handshakes for the Swiggy connect flow, keyed by
   * `state`. Shared between the connect route (which records them) and the
   * `/oauth/swiggy/callback` route (which consumes them atomically). Durable
   * in production so handshakes survive restarts and work across instances.
   */
  swiggyOAuthCallbacks: OAuthCallbackStore;
}

/**
 * A connection that can run queries — either the top-level {@link Database} or
 * a transaction (`tx`). Used so helpers can run inside a `db.transaction` and
 * keep multi-write sequences atomic.
 */
export type DbConnection = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
