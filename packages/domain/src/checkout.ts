import type { SystemEventType, ISODateTime } from './domain-types.js';
import type { HouseholdId, MembershipId } from './ids.js';
import type { ProviderCartReview, ProviderOrder } from './provider.js';

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
/** Instamart's documented minimum order value: ₹99 in paise. */
export const CART_VALUE_MINIMUM_CENTS = 9_900;

export type CheckoutDecisionReason =
  'eligible' | 'min_order_not_met' | 'over_limit' | 'no_payment_method' | 'disabled';

export interface CheckoutDecision {
  eligible: boolean;
  reason: CheckoutDecisionReason;
  /** When not eligible through Cooklink, hand off to the Instamart app. */
  fallback: 'instamart_app' | null;
}

/**
 * Decide whether a cart may complete through Cooklink Checkout (issue 01).
 * - total below ₹99 → keep reviewing the cart;
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
  if (totalCents < CART_VALUE_MINIMUM_CENTS) {
    return { eligible: false, reason: 'min_order_not_met', fallback: null };
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

// ---- fresh explicit Member confirmation (issue 11, AC#1 / AC#2) ----

/** A short-lived confirmation token so checkout never runs on a stale cart. */
export const CHECKOUT_CONFIRMATION_TTL_MS = 60_000;

/**
 * A fresh, explicit Member confirmation snapshot taken immediately before
 * asking the Member to confirm checkout (issue 11, AC#1 — Cooklink shows the
 * canonical cart, address, selected returned payment method, store count, and
 * total). The server issues this token and MUST re-validate it at submission
 * so checkout never runs without a fresh explicit confirmation (AC#2).
 */
export interface CheckoutConfirmation {
  /** Opaque token binding this confirmation to the issuing server session. */
  token: string;
  householdId: HouseholdId;
  membershipId: MembershipId;
  addressId: string;
  /** The selected returned payment method (AC#1 — only provider-returned). */
  paymentMethodId: string | null;
  storeCount: number;
  totalCents: number;
  itemCount: number;
  /** Stable signature of the cart line items; any change invalidates the token. */
  cartSignature: string;
  issuedAt: ISODateTime;
  expiresAt: ISODateTime;
}

/**
 * Compute a stable signature for a cart's line items so any change to the
 * product set or quantities invalidates a prior confirmation (AC#2).
 */
export function cartSignature(items: { productId: string; quantity: number }[]): string {
  const sorted = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
  return sorted.map((i) => `${i.productId}:${i.quantity}`).join('|');
}

/** Extract the {productId, quantity} pairs from a provider cart review. */
function cartLineSignature(review: ProviderCartReview): string {
  return cartSignature(review.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
}

/**
 * Issue a fresh confirmation snapshot from the canonical cart review (AC#1).
 * The Member reviews this exact snapshot before confirming; the server
 * re-validates it at checkout time.
 */
export function buildCheckoutConfirmation(input: {
  token: string;
  householdId: HouseholdId;
  membershipId: MembershipId;
  review: ProviderCartReview;
  paymentMethodId: string | null;
  now: Date;
}): CheckoutConfirmation {
  const issuedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + CHECKOUT_CONFIRMATION_TTL_MS).toISOString();
  return {
    token: input.token,
    householdId: input.householdId,
    membershipId: input.membershipId,
    addressId: input.review.addressId,
    paymentMethodId: input.paymentMethodId,
    storeCount: input.review.storeCount,
    totalCents: input.review.totalCents,
    itemCount: input.review.items.length,
    cartSignature: cartLineSignature(input.review),
    issuedAt,
    expiresAt,
  };
}

export type ConfirmationValidationReason =
  | 'expired'
  | 'membership_mismatch'
  | 'address_mismatch'
  | 'payment_method_mismatch'
  | 'cart_changed'
  | 'total_mismatch'
  | 'store_count_mismatch';

/**
 * Validate a fresh explicit Member confirmation against the live cart review
 * at checkout time (issue 11, AC#2). Checkout never runs unless this returns
 * `valid: true`: the token must be non-expired, bound to the acting member,
 * and still match the canonical cart, address, selected payment method, store
 * count, and total.
 */
export function confirmationMatches(
  confirmation: CheckoutConfirmation,
  live: {
    membershipId: MembershipId;
    review: ProviderCartReview;
    paymentMethodId: string | null;
  },
  now: Date,
): { valid: boolean; reason?: ConfirmationValidationReason } {
  if (now.getTime() >= new Date(confirmation.expiresAt).getTime()) {
    return { valid: false, reason: 'expired' };
  }
  if (confirmation.membershipId !== live.membershipId) {
    return { valid: false, reason: 'membership_mismatch' };
  }
  if (confirmation.addressId !== live.review.addressId) {
    return { valid: false, reason: 'address_mismatch' };
  }
  if (confirmation.paymentMethodId !== live.paymentMethodId) {
    return { valid: false, reason: 'payment_method_mismatch' };
  }
  if (confirmation.storeCount !== live.review.storeCount) {
    return { valid: false, reason: 'store_count_mismatch' };
  }
  const liveSignature = cartLineSignature(live.review);
  if (confirmation.cartSignature !== liveSignature) {
    return { valid: false, reason: 'cart_changed' };
  }
  if (confirmation.totalCents !== live.review.totalCents) {
    return { valid: false, reason: 'total_mismatch' };
  }
  return { valid: true };
}

// ---- multi-store partial success (issue 11, AC#7) ----

/**
 * Classify a provider checkout result across per-store orders so partial
 * success is shown per resulting order rather than as one misleading success
 * or failure (AC#7). A `failed`/`cancelled` order counts as not-succeeded.
 */
export function classifyCheckoutResult(orders: ProviderOrder[]): {
  allSucceeded: boolean;
  partialSuccess: boolean;
  succeededCount: number;
  failedCount: number;
} {
  if (orders.length === 0) {
    return { allSucceeded: false, partialSuccess: false, succeededCount: 0, failedCount: 0 };
  }
  const succeeded = orders.filter((o) => o.status !== 'failed' && o.status !== 'cancelled').length;
  const failed = orders.length - succeeded;
  return {
    allSucceeded: failed === 0,
    partialSuccess: succeeded > 0 && failed > 0,
    succeededCount: succeeded,
    failedCount: failed,
  };
}

// ---- cancellation guidance (issue 11, AC#8) ----

export interface CancellationGuidance {
  /** True when the provider contract still allows the member to cancel. */
  cancellable: boolean;
  /** Why: within_window / past_cancellation_window / already_terminal. */
  reason: 'within_window' | 'past_cancellation_window' | 'already_terminal';
  /** The provider's cancellation policy, surfaced verbatim (AC#8). */
  instruction: string;
}

/**
 * Produce cancellation guidance that follows the provider contract (issue 11,
 * AC#8). Cooklink never cancels on the member's behalf; it surfaces whether
 * the order is still cancellable and the provider's policy text. A delivered,
 * out-for-delivery, or already-cancelled order is terminal.
 */
export function cancellationGuidance(order: ProviderOrder, now: Date): CancellationGuidance {
  const policy = order.cancellationPolicy;
  if (
    order.status === 'delivered' ||
    order.status === 'out_for_delivery' ||
    order.status === 'cancelled'
  ) {
    return { cancellable: false, reason: 'already_terminal', instruction: policy };
  }
  if (order.cancellableUntil && new Date(order.cancellableUntil).getTime() > now.getTime()) {
    return { cancellable: true, reason: 'within_window', instruction: policy };
  }
  return { cancellable: false, reason: 'past_cancellation_window', instruction: policy };
}

// ---- checkout audit result labels (issue 11, AC#5) ----

/** The append-only audit `result` values for a checkout attempt. */
export type CheckoutAuditResult =
  | 'succeeded'
  | 'partial_success'
  | 'failed'
  | 'fallback_instamart_app'
  | 'recovered_order_already_placed'
  | 'denied_disabled'
  | 'denied_ineligible'
  | 'denied_stale_confirmation';

/** Map a checkout outcome to the audit result label. */
export function auditResultFor(outcome: {
  placed: boolean;
  partialSuccess: boolean;
  fallback: boolean;
  recoveredAlreadyPlaced: boolean;
  denied: 'disabled' | 'ineligible' | 'stale_confirmation' | null;
}): CheckoutAuditResult {
  if (outcome.denied === 'disabled') return 'denied_disabled';
  if (outcome.denied === 'ineligible') return 'denied_ineligible';
  if (outcome.denied === 'stale_confirmation') return 'denied_stale_confirmation';
  if (outcome.recoveredAlreadyPlaced) return 'recovered_order_already_placed';
  if (outcome.fallback) return 'fallback_instamart_app';
  if (outcome.placed && outcome.partialSuccess) return 'partial_success';
  if (outcome.placed) return 'succeeded';
  return 'failed';
}
