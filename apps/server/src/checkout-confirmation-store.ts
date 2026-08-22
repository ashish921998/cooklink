import type { CheckoutConfirmation } from '@cooklink/domain';

/**
 * A short-lived, in-process checkout confirmation store (issue 11). Tokens
 * expire after the confirmation's own TTL and are scoped to the issuing
 * membership. The store is intentionally simple and not durable: a restart
 * invalidates outstanding tokens (fail-closed), and the DB-backed idempotency
 * key is the real duplicate-order safety net (AC#5).
 */
export interface CheckoutConfirmationStore {
  issue(confirmation: CheckoutConfirmation): void;
  consume(token: string): CheckoutConfirmation | null;
}

/** The default in-memory store; safe for V1 single-instance deployment. */
export function createInMemoryConfirmationStore(): CheckoutConfirmationStore {
  const store = new Map<string, CheckoutConfirmation>();
  return {
    issue(confirmation) {
      store.set(confirmation.token, confirmation);
      // Evict lazily; TTL is re-checked at consume time too.
      const expiresAt = new Date(confirmation.expiresAt).getTime();
      setTimeout(
        () => store.delete(confirmation.token),
        Math.max(0, expiresAt - Date.now()),
      ).unref?.();
    },
    consume(token) {
      const conf = store.get(token);
      if (!conf) return null;
      // Single-use: delete on read so a confirmation cannot be replayed.
      store.delete(token);
      if (Date.now() >= new Date(conf.expiresAt).getTime()) {
        return null;
      }
      return conf;
    },
  };
}
