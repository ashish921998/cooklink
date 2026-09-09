import { and, eq } from 'drizzle-orm';
import {
  checkoutConfirmations,
  swiggyOAuthCallbacks,
  swiggyOAuthPending,
  swiggyRecentProducts,
  type Database,
} from '@cooklink/db';
import type { CheckoutConfirmation, MembershipId, ProviderProduct, UserId } from '@cooklink/domain';
import { decodeSecretKey, decryptSecret, encryptSecret } from './secret-box.js';
import type {
  CheckoutConfirmationStore,
  ConsumedConfirmation,
} from './checkout-confirmation-store.js';

/**
 * Durable storage for the Swiggy flow state that used to live in
 * process-local Maps (issue 13 — safe across restarts and independent
 * server instances):
 *
 * - `PendingOAuthStore` — pending delegated-OAuth (PKCE) handshakes. The PKCE
 *   code verifier and the dynamic client secret are stored encrypted with
 *   AES-256-GCM; they are never logged. `consume` is an atomic
 *   delete-and-return keyed by the opaque `state`, so a replayed callback or
 *   a concurrent duplicate can never exchange the same authorization code
 *   twice, on any instance.
 * - `OAuthCallbackStore` — the browser-callback routing record binding a
 *   `state` to the member to return to. Also consumed exactly once.
 * - `ProductCacheStore` — the recent-product cache behind unavailable-product
 *   alternatives. Purely a reconstructible cache; swept after the TTL.
 * - `createDatabaseConfirmationStore` — single-use checkout confirmations,
 *   consumed atomically and bound to the issuing membership.
 *
 * Every table carries an explicit `expiresAt` so the `flow_state_cleanup`
 * scheduler job can expire state exactly like the old in-process TTLs did.
 */

export const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OAUTH_PENDING_TTL_MS = 10 * 60_000;

// ---- pending OAuth (PKCE) ----

export interface PendingOAuth {
  userId: UserId;
  redirectUri: string;
  clientId: string;
  clientSecret: string | null;
  codeVerifier: string;
  /** Epoch milliseconds when the handshake was started (TTL origin). */
  createdAt: number;
}

export interface PendingOAuthStore {
  save(state: string, pending: PendingOAuth, ttlMs: number): Promise<void>;
  /**
   * Atomically consume a pending handshake for the expected owner: the row is
   * deleted in the same statement that returns it, so exactly one caller can
   * complete a state, and a different member can neither use nor destroy
   * another member's handshake. Returns null when the state is unknown,
   * expired, or owned by someone else.
   */
  consume(state: string, expectedUserId?: UserId): Promise<PendingOAuth | null>;
}

export function createDatabasePendingOAuthStore(
  db: Database,
  encryptionKey: string,
): PendingOAuthStore {
  const key = decodeSecretKey(encryptionKey);
  return {
    async save(state, pending, ttlMs) {
      await db
        .insert(swiggyOAuthPending)
        .values({
          state,
          userId: pending.userId as string,
          redirectUri: pending.redirectUri,
          clientId: pending.clientId,
          encryptedClientSecret: pending.clientSecret
            ? encryptSecret(pending.clientSecret, key)
            : null,
          encryptedCodeVerifier: encryptSecret(pending.codeVerifier, key),
          createdAt: new Date(pending.createdAt),
          expiresAt: new Date(pending.createdAt + ttlMs),
        })
        .onConflictDoUpdate({
          target: swiggyOAuthPending.state,
          set: {
            userId: pending.userId as string,
            redirectUri: pending.redirectUri,
            clientId: pending.clientId,
            encryptedClientSecret: pending.clientSecret
              ? encryptSecret(pending.clientSecret, key)
              : null,
            encryptedCodeVerifier: encryptSecret(pending.codeVerifier, key),
            createdAt: new Date(pending.createdAt),
            expiresAt: new Date(pending.createdAt + ttlMs),
          },
        });
    },
    async consume(state, expectedUserId) {
      const [row] = await db
        .delete(swiggyOAuthPending)
        .where(
          expectedUserId
            ? and(
                eq(swiggyOAuthPending.state, state),
                eq(swiggyOAuthPending.userId, expectedUserId as string),
              )
            : eq(swiggyOAuthPending.state, state),
        )
        .returning();
      if (!row) return null;
      if (row.expiresAt.getTime() <= Date.now()) return null;
      try {
        return {
          userId: row.userId as UserId,
          redirectUri: row.redirectUri,
          clientId: row.clientId,
          clientSecret: row.encryptedClientSecret
            ? decryptSecret(row.encryptedClientSecret, key)
            : null,
          codeVerifier: decryptSecret(row.encryptedCodeVerifier, key),
          createdAt: row.createdAt.getTime(),
        };
      } catch {
        // A rotated/missing key must fail closed: the handshake is unusable
        // rather than exposed. The row is already consumed.
        return null;
      }
    },
  };
}

/** In-memory fallback (single-process development and unit tests). */
export function createMemoryPendingOAuthStore(): PendingOAuthStore {
  const store = new Map<string, { pending: PendingOAuth; expiresAt: number }>();
  return {
    async save(state, pending, ttlMs) {
      store.set(state, { pending, expiresAt: pending.createdAt + ttlMs });
    },
    async consume(state, expectedUserId) {
      const entry = store.get(state);
      if (!entry) return null;
      if (expectedUserId && entry.pending.userId !== expectedUserId) return null;
      store.delete(state);
      if (entry.expiresAt <= Date.now()) return null;
      return entry.pending;
    },
  };
}

// ---- browser-OAuth callback routing ----

export interface OAuthCallbackRecord {
  userId: UserId;
  appReturnUri: string;
}

export interface OAuthCallbackStore {
  save(state: string, callback: OAuthCallbackRecord, ttlMs: number): Promise<void>;
  /** Atomically consume the callback record for a state (single-use). */
  consume(state: string): Promise<OAuthCallbackRecord | null>;
}

export function createDatabaseOAuthCallbackStore(db: Database): OAuthCallbackStore {
  return {
    async save(state, callback, ttlMs) {
      const now = new Date();
      await db
        .insert(swiggyOAuthCallbacks)
        .values({
          state,
          userId: callback.userId as string,
          appReturnUri: callback.appReturnUri,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        })
        .onConflictDoUpdate({
          target: swiggyOAuthCallbacks.state,
          set: {
            userId: callback.userId as string,
            appReturnUri: callback.appReturnUri,
            createdAt: now,
            expiresAt: new Date(now.getTime() + ttlMs),
          },
        });
    },
    async consume(state) {
      const [row] = await db
        .delete(swiggyOAuthCallbacks)
        .where(eq(swiggyOAuthCallbacks.state, state))
        .returning();
      if (!row || row.expiresAt.getTime() <= Date.now()) return null;
      return { userId: row.userId as UserId, appReturnUri: row.appReturnUri };
    },
  };
}

/** In-memory fallback (single-process development and unit tests). */
export function createMemoryOAuthCallbackStore(): OAuthCallbackStore {
  const store = new Map<string, { callback: OAuthCallbackRecord; expiresAt: number }>();
  return {
    async save(state, callback, ttlMs) {
      store.set(state, { callback, expiresAt: Date.now() + ttlMs });
    },
    async consume(state) {
      const entry = store.get(state);
      store.delete(state);
      if (!entry || entry.expiresAt <= Date.now()) return null;
      return entry.callback;
    },
  };
}

// ---- recent-product cache ----

export interface ProductCacheStore {
  remember(userId: UserId, products: ProviderProduct[]): Promise<void>;
  get(userId: UserId, productId: string): Promise<ProviderProduct | null>;
  clear(userId: UserId): Promise<void>;
}

export function createDatabaseProductCacheStore(db: Database): ProductCacheStore {
  return {
    async remember(userId, products) {
      const now = new Date();
      for (const product of products) {
        await db
          .insert(swiggyRecentProducts)
          .values({
            userId: userId as string,
            productId: product.id,
            product,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [swiggyRecentProducts.userId, swiggyRecentProducts.productId],
            set: { product, updatedAt: now },
          });
      }
    },
    async get(userId, productId) {
      const [row] = await db
        .select()
        .from(swiggyRecentProducts)
        .where(
          and(
            eq(swiggyRecentProducts.userId, userId as string),
            eq(swiggyRecentProducts.productId, productId),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (Date.now() - row.updatedAt.getTime() > PRODUCT_CACHE_TTL_MS) return null;
      return row.product as ProviderProduct;
    },
    async clear(userId) {
      await db
        .delete(swiggyRecentProducts)
        .where(eq(swiggyRecentProducts.userId, userId as string));
    },
  };
}

/** In-memory fallback (single-process development and unit tests). */
export function createMemoryProductCacheStore(): ProductCacheStore {
  const store = new Map<string, Map<string, { product: ProviderProduct; at: number }>>();
  return {
    async remember(userId, products) {
      const cache = store.get(userId as string) ?? new Map();
      for (const product of products) cache.set(product.id, { product, at: Date.now() });
      store.set(userId as string, cache);
    },
    async get(userId, productId) {
      const entry = store.get(userId as string)?.get(productId);
      if (!entry || Date.now() - entry.at > PRODUCT_CACHE_TTL_MS) return null;
      return entry.product;
    },
    async clear(userId) {
      store.delete(userId as string);
    },
  };
}

// ---- checkout confirmations ----

export function createDatabaseConfirmationStore(db: Database): CheckoutConfirmationStore {
  return {
    async issue(confirmation: CheckoutConfirmation) {
      await db.insert(checkoutConfirmations).values({
        token: confirmation.token,
        membershipId: confirmation.membershipId as string,
        householdId: confirmation.householdId as string,
        snapshot: confirmation,
        expiresAt: new Date(confirmation.expiresAt),
      });
    },
    async consume(
      token: string,
      expectedMembershipId?: MembershipId,
    ): Promise<ConsumedConfirmation> {
      // Atomic single-use consume bound to the issuing membership: a foreign
      // member can neither spend nor destroy another member's confirmation.
      const deleted = await db
        .delete(checkoutConfirmations)
        .where(
          expectedMembershipId
            ? and(
                eq(checkoutConfirmations.token, token),
                eq(checkoutConfirmations.membershipId, expectedMembershipId as string),
              )
            : eq(checkoutConfirmations.token, token),
        )
        .returning();
      const [row] = deleted;
      if (row) {
        if (row.expiresAt.getTime() <= Date.now()) return null;
        return { kind: 'consumed', confirmation: row.snapshot as CheckoutConfirmation };
      }
      // Nothing was consumed: either the token is unknown/used/expired, or it
      // belongs to a different membership. Distinguish without consuming.
      if (!expectedMembershipId) return null;
      const [existing] = await db
        .select({ membershipId: checkoutConfirmations.membershipId })
        .from(checkoutConfirmations)
        .where(eq(checkoutConfirmations.token, token))
        .limit(1);
      if (!existing) return null;
      return existing.membershipId === (expectedMembershipId as string)
        ? null // owner raced ahead and consumed it — treat as used up
        : { kind: 'membership_mismatch' };
    },
  };
}
