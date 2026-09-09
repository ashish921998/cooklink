import type { CheckoutConfirmation, MembershipId } from '@cooklink/domain';

/**
 * The outcome of atomically consuming a single-use checkout confirmation.
 * - `consumed`: the token belonged to the expected membership and is now
 *   spent — the confirmation snapshot is returned.
 * - `membership_mismatch`: the token exists but belongs to a different
 *   membership. It is NOT consumed; its rightful owner can still use it.
 * - `null`: no live token (unknown, already consumed, or expired).
 */
export type ConsumedConfirmation =
  { kind: 'consumed'; confirmation: CheckoutConfirmation } | { kind: 'membership_mismatch' } | null;

/**
 * A short-lived checkout confirmation store (issue 11). Tokens expire after
 * the confirmation's own TTL and are scoped to the issuing membership.
 * `consume` is atomic and single-use: exactly one concurrent caller can spend
 * a token, and a foreign member can neither use nor destroy another member's
 * confirmation.
 */
export interface CheckoutConfirmationStore {
  issue(confirmation: CheckoutConfirmation): Promise<void>;
  consume(token: string, expectedMembershipId?: MembershipId): Promise<ConsumedConfirmation>;
}

/**
 * The default in-memory store; safe for single-instance development. A
 * restart invalidates outstanding tokens (fail-closed), and the DB-backed
 * idempotency key is the real duplicate-order safety net (AC#5). Production
 * wiring uses the durable PostgreSQL store in `flow-state.ts` so
 * confirmations survive restarts and work across independent instances.
 */
export function createInMemoryConfirmationStore(): CheckoutConfirmationStore {
  const store = new Map<string, CheckoutConfirmation>();
  return {
    async issue(confirmation) {
      store.set(confirmation.token, confirmation);
      // Evict lazily; TTL is re-checked at consume time too.
      const expiresAt = new Date(confirmation.expiresAt).getTime();
      setTimeout(
        () => store.delete(confirmation.token),
        Math.max(0, expiresAt - Date.now()),
      ).unref?.();
    },
    async consume(token, expectedMembershipId) {
      const conf = store.get(token);
      if (!conf) return null;
      // Ownership first: a foreign member can neither use nor burn the token.
      if (expectedMembershipId && conf.membershipId !== expectedMembershipId) {
        return { kind: 'membership_mismatch' };
      }
      // Single-use: delete on read so a confirmation cannot be replayed.
      store.delete(token);
      if (Date.now() >= new Date(conf.expiresAt).getTime()) {
        return null;
      }
      return { kind: 'consumed', confirmation: conf };
    },
  };
}
