import type { SystemEventType } from './types.js';

/**
 * Instamart ordering boundary (issue 01 / 05 / 07).
 *
 * Checkout is non-idempotent and duplicate-safe by construction. Cooklink never
 * silently substitutes, never collects payment credentials, and always requires
 * a fresh Member confirmation + server-side role check. Real ordering is
 * feature-gated until Swiggy grants production access.
 */

/** ₹1,000 in paise (the conservative V1 boundary). */
export const CART_VALUE_LIMIT_CENTS = 100_000;

export type CheckoutDecisionReason =
  | 'eligible'
  | 'over_limit'
  | 'no_payment_method'
  | 'disabled';

export interface CheckoutDecision {
  eligible: boolean;
  reason: CheckoutDecisionReason;
  /** When not eligible through Cooklink, hand off to the Instamart app. */
  fallback: 'instamart_app' | null;
}

/**
 * Decide whether a cart may complete through Cooklink Checkout (issue 01).
 * - total at or above ₹1,000 → Instamart app fallback;
 * - no payment method returned by the cart → Instamart app fallback;
 * - otherwise eligible (subject to the production feature gate).
 */
export function decideCheckout(
  totalCents: number,
  availablePaymentMethods: string[],
  orderingEnabled: boolean,
): CheckoutDecision {
  if (!orderingEnabled) {
    return { eligible: false, reason: 'disabled', fallback: null };
  }
  if (totalCents >= CART_VALUE_LIMIT_CENTS) {
    return { eligible: false, reason: 'over_limit', fallback: 'instamart_app' };
  }
  if (availablePaymentMethods.length === 0) {
    return { eligible: false, reason: 'no_payment_method', fallback: 'instamart_app' };
  }
  return { eligible: true, reason: 'eligible', fallback: null };
}

/**
 * Whether a single returned payment method may be preselected (issue 08).
 * One method → may preselect; several → require a Member choice; none → fallback.
 */
export function paymentSelection(methods: string[]): {
  preselect: boolean;
  requiresChoice: boolean;
} {
  return { preselect: methods.length === 1, requiresChoice: methods.length > 1 };
}

/**
 * After checkout uncertainty (network error / 5xx), the server MUST consult
 * `get_orders` before any retry rather than blindly re-checking out
 * (issue 07, AC#9). This function encodes that decision.
 */
export function shouldRetryCheckout(args: {
  uncertainFailure: boolean;
  orderAlreadyPlaced: boolean;
}): boolean {
  if (!args.uncertainFailure) return false;
  // If get_orders proved an order was already placed, NEVER retry.
  return !args.orderAlreadyPlaced;
}

/** Payment/order events that must be redacted from previews (issue 06). */
export const MONEY_ORDER_EVENTS: ReadonlySet<SystemEventType> = new Set([
  'grocery_order.placed',
  'grocery_order.failed',
  'grocery_order.delivery_updated',
]);

/** Idempotency key namespace for checkout attempts. */
export function checkoutIdempotencyKey(membershipId: string, cartSignature: string): string {
  return `checkout:${membershipId}:${cartSignature}`;
}
