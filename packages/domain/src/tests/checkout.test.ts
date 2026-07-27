import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from '../ids.js';
import {
  decideCheckout,
  paymentSelection,
  shouldRetryCheckout,
  CART_VALUE_LIMIT_CENTS,
  cartSignature,
  buildCheckoutConfirmation,
  confirmationMatches,
  classifyCheckoutResult,
  cancellationGuidance,
  auditResultFor,
  CHECKOUT_CONFIRMATION_TTL_MS,
} from '../checkout.js';
import type { ProviderCartReview, ProviderOrder } from '../provider.js';

const HOUSEHOLD = id<'HouseholdId'>('h-1');
const MEMBER = id<'MembershipId'>('m-1');

function makeReview(overrides: Partial<ProviderCartReview> = {}): ProviderCartReview {
  return {
    addressId: 'addr-home',
    items: [
      {
        productId: 'prod-tomato-500',
        name: 'Tomato',
        brand: 'Fresh Farms',
        variant: 'Ripe',
        packSize: '500 g',
        quantity: 2,
        priceCents: 3000,
        lineTotalCents: 6000,
        available: true,
        storeId: 'store-1',
        storeName: 'Instamart Store 1',
      },
    ],
    bill: [
      { label: 'Item total', amountCents: 6000 },
      { label: 'Delivery fee', amountCents: 2500 },
      { label: 'Total', amountCents: 8500 },
    ],
    totalCents: 8500,
    availablePaymentMethods: [{ id: 'pm-cod', label: 'COD', kind: 'COD' }],
    storeCount: 1,
    hasUnavailableItems: false,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<ProviderOrder> = {}): ProviderOrder {
  return {
    id: 'ord-1',
    status: 'placed',
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    totalCents: 8500,
    items: [],
    placedAt: '2026-07-27T10:00:00.000Z',
    deliveryEta: '2026-07-27T11:00:00.000Z',
    trackingUrl: 'https://instamart.swiggy.com/track/ord-1',
    cancellableUntil: '2026-07-27T10:05:00.000Z',
    cancellationPolicy: 'Cancellable within 5 minutes of placing.',
    ...overrides,
  };
}

test('carts below ₹1,000 with a payment method are eligible', () => {
  const d = decideCheckout(50_000, ['COD'], true);
  assert.equal(d.eligible, true);
  assert.equal(d.reason, 'eligible');
  assert.equal(d.fallback, null);
});

test('carts at or above ₹1,000 fall back to the Instamart app', () => {
  const d = decideCheckout(CART_VALUE_LIMIT_CENTS, ['COD'], true);
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'over_limit');
  assert.equal(d.fallback, 'instamart_app');
});

test('no returned payment method falls back to the Instamart app', () => {
  const d = decideCheckout(20_000, [], true);
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'no_payment_method');
  assert.equal(d.fallback, 'instamart_app');
});

test('ordering disabled by feature gate until Swiggy production access', () => {
  const d = decideCheckout(20_000, ['COD'], false);
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'disabled');
});

test('one payment method may be preselected; several require a choice', () => {
  assert.deepEqual(paymentSelection(['COD']), { preselect: true, requiresChoice: false });
  assert.deepEqual(paymentSelection(['COD', 'UPI']), { preselect: false, requiresChoice: true });
});

test('after uncertainty, never retry if get_orders shows an order already placed', () => {
  assert.equal(shouldRetryCheckout({ uncertainFailure: true, orderAlreadyPlaced: true }), false);
  assert.equal(shouldRetryCheckout({ uncertainFailure: true, orderAlreadyPlaced: false }), true);
  // a deterministic failure must not be retried blindly
  assert.equal(shouldRetryCheckout({ uncertainFailure: false, orderAlreadyPlaced: false }), false);
});

// ---- AC#1 / AC#2: fresh explicit Member confirmation ----

test('cartSignature is stable regardless of input order', () => {
  const a = cartSignature([
    { productId: 'p-b', quantity: 1 },
    { productId: 'p-a', quantity: 2 },
  ]);
  const b = cartSignature([
    { productId: 'p-a', quantity: 2 },
    { productId: 'p-b', quantity: 1 },
  ]);
  assert.equal(a, b);
  assert.equal(a, 'p-a:2|p-b:1');
});

test('cartSignature changes when quantity or product set changes', () => {
  const base = cartSignature([{ productId: 'p-a', quantity: 2 }]);
  assert.notEqual(cartSignature([{ productId: 'p-a', quantity: 3 }]), base);
  assert.notEqual(
    cartSignature([
      { productId: 'p-a', quantity: 2 },
      { productId: 'p-b', quantity: 1 },
    ]),
    base,
  );
});

test('buildCheckoutConfirmation snapshots the canonical cart, address, payment, store count, total', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const conf = buildCheckoutConfirmation({
    token: 'tok-1',
    householdId: HOUSEHOLD,
    membershipId: MEMBER,
    review: makeReview(),
    paymentMethodId: 'pm-cod',
    now,
  });
  assert.equal(conf.token, 'tok-1');
  assert.equal(conf.addressId, 'addr-home');
  assert.equal(conf.paymentMethodId, 'pm-cod');
  assert.equal(conf.storeCount, 1);
  assert.equal(conf.totalCents, 8500);
  assert.equal(conf.itemCount, 1);
  assert.equal(conf.issuedAt, now.toISOString());
  assert.equal(new Date(conf.expiresAt).getTime() - now.getTime(), CHECKOUT_CONFIRMATION_TTL_MS);
});

test('confirmationMatches: valid when the live cart still matches the snapshot', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const conf = buildCheckoutConfirmation({
    token: 'tok-1',
    householdId: HOUSEHOLD,
    membershipId: MEMBER,
    review: makeReview(),
    paymentMethodId: 'pm-cod',
    now,
  });
  const result = confirmationMatches(
    conf,
    { membershipId: MEMBER, review: makeReview(), paymentMethodId: 'pm-cod' },
    new Date('2026-07-27T10:00:30.000Z'),
  );
  assert.equal(result.valid, true);
});

test('confirmationMatches: expired after the TTL', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const conf = buildCheckoutConfirmation({
    token: 'tok-1',
    householdId: HOUSEHOLD,
    membershipId: MEMBER,
    review: makeReview(),
    paymentMethodId: 'pm-cod',
    now,
  });
  const result = confirmationMatches(
    conf,
    { membershipId: MEMBER, review: makeReview(), paymentMethodId: 'pm-cod' },
    new Date('2026-07-27T10:02:00.000Z'),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

test('confirmationMatches: membership mismatch denies (AC#2 role binding)', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const conf = buildCheckoutConfirmation({
    token: 'tok-1',
    householdId: HOUSEHOLD,
    membershipId: MEMBER,
    review: makeReview(),
    paymentMethodId: 'pm-cod',
    now,
  });
  const other = id<'MembershipId'>('m-2');
  const result = confirmationMatches(
    conf,
    { membershipId: other, review: makeReview(), paymentMethodId: 'pm-cod' },
    now,
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'membership_mismatch');
});

test('confirmationMatches: a changed cart (quantity/price) denies checkout', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const conf = buildCheckoutConfirmation({
    token: 'tok-1',
    householdId: HOUSEHOLD,
    membershipId: MEMBER,
    review: makeReview(),
    paymentMethodId: 'pm-cod',
    now,
  });
  const changed = makeReview({
    items: [
      {
        productId: 'prod-tomato-500',
        name: 'Tomato',
        brand: 'Fresh Farms',
        variant: 'Ripe',
        packSize: '500 g',
        quantity: 5, // changed
        priceCents: 3000,
        lineTotalCents: 15000,
        available: true,
        storeId: 'store-1',
        storeName: 'Instamart Store 1',
      },
    ],
    totalCents: 17500,
  });
  const result = confirmationMatches(
    conf,
    { membershipId: MEMBER, review: changed, paymentMethodId: 'pm-cod' },
    now,
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cart_changed');
});

test('confirmationMatches: address, payment method, store count, total mismatches each deny', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const conf = buildCheckoutConfirmation({
    token: 'tok-1',
    householdId: HOUSEHOLD,
    membershipId: MEMBER,
    review: makeReview(),
    paymentMethodId: 'pm-cod',
    now,
  });
  assert.equal(
    confirmationMatches(
      conf,
      {
        membershipId: MEMBER,
        review: makeReview({ addressId: 'addr-other' }),
        paymentMethodId: 'pm-cod',
      },
      now,
    ).reason,
    'address_mismatch',
  );
  assert.equal(
    confirmationMatches(
      conf,
      { membershipId: MEMBER, review: makeReview(), paymentMethodId: 'pm-upi' },
      now,
    ).reason,
    'payment_method_mismatch',
  );
  assert.equal(
    confirmationMatches(
      conf,
      { membershipId: MEMBER, review: makeReview({ storeCount: 2 }), paymentMethodId: 'pm-cod' },
      now,
    ).reason,
    'store_count_mismatch',
  );
  assert.equal(
    confirmationMatches(
      conf,
      { membershipId: MEMBER, review: makeReview({ totalCents: 9999 }), paymentMethodId: 'pm-cod' },
      now,
    ).reason,
    'total_mismatch',
  );
});

// ---- AC#7: multi-store partial success ----

test('classifyCheckoutResult: all succeeded when every per-store order placed', () => {
  const c = classifyCheckoutResult([
    makeOrder({ id: 'ord-1', status: 'placed' }),
    makeOrder({ id: 'ord-2', status: 'confirmed', storeId: 'store-2' }),
  ]);
  assert.equal(c.allSucceeded, true);
  assert.equal(c.partialSuccess, false);
  assert.equal(c.succeededCount, 2);
  assert.equal(c.failedCount, 0);
});

test('classifyCheckoutResult: partial success when some but not all stores placed', () => {
  const c = classifyCheckoutResult([
    makeOrder({ id: 'ord-1', status: 'placed' }),
    makeOrder({ id: 'ord-2', status: 'failed', storeId: 'store-2' }),
  ]);
  assert.equal(c.allSucceeded, false);
  assert.equal(c.partialSuccess, true);
  assert.equal(c.succeededCount, 1);
  assert.equal(c.failedCount, 1);
});

test('classifyCheckoutResult: all failed when no store placed', () => {
  const c = classifyCheckoutResult([makeOrder({ id: 'ord-1', status: 'failed' })]);
  assert.equal(c.allSucceeded, false);
  assert.equal(c.partialSuccess, false);
  assert.equal(c.failedCount, 1);
});

test('classifyCheckoutResult: cancelled counts as not-succeeded', () => {
  const c = classifyCheckoutResult([makeOrder({ id: 'ord-1', status: 'cancelled' })]);
  assert.equal(c.allSucceeded, false);
  assert.equal(c.failedCount, 1);
});

test('classifyCheckoutResult: empty is neither success nor partial', () => {
  const c = classifyCheckoutResult([]);
  assert.equal(c.allSucceeded, false);
  assert.equal(c.partialSuccess, false);
  assert.equal(c.succeededCount, 0);
});

// ---- AC#8: cancellation guidance follows the provider contract ----

test('cancellationGuidance: cancellable within the provider window', () => {
  const now = new Date('2026-07-27T10:01:00.000Z');
  const g = cancellationGuidance(
    makeOrder({ cancellableUntil: '2026-07-27T10:05:00.000Z', status: 'placed' }),
    now,
  );
  assert.equal(g.cancellable, true);
  assert.equal(g.reason, 'within_window');
  assert.equal(g.instruction, 'Cancellable within 5 minutes of placing.');
});

test('cancellationGuidance: past the cancellation window is not cancellable', () => {
  const now = new Date('2026-07-27T10:10:00.000Z');
  const g = cancellationGuidance(
    makeOrder({ cancellableUntil: '2026-07-27T10:05:00.000Z', status: 'confirmed' }),
    now,
  );
  assert.equal(g.cancellable, false);
  assert.equal(g.reason, 'past_cancellation_window');
});

test('cancellationGuidance: delivered/out-for-delivery/cancelled are terminal', () => {
  const now = new Date('2026-07-27T10:01:00.000Z');
  for (const status of ['delivered', 'out_for_delivery', 'cancelled'] as const) {
    const g = cancellationGuidance(
      makeOrder({ status, cancellableUntil: '2099-01-01T00:00:00.000Z' }),
      now,
    );
    assert.equal(g.cancellable, false, `${status} should be terminal`);
    assert.equal(g.reason, 'already_terminal', `${status} should be already_terminal`);
  }
});

// ---- AC#5: audit result labels ----

test('auditResultFor: maps outcomes to append-only audit labels', () => {
  assert.equal(
    auditResultFor({
      placed: true,
      partialSuccess: false,
      fallback: false,
      recoveredAlreadyPlaced: false,
      denied: null,
    }),
    'succeeded',
  );
  assert.equal(
    auditResultFor({
      placed: true,
      partialSuccess: true,
      fallback: false,
      recoveredAlreadyPlaced: false,
      denied: null,
    }),
    'partial_success',
  );
  assert.equal(
    auditResultFor({
      placed: false,
      partialSuccess: false,
      fallback: true,
      recoveredAlreadyPlaced: false,
      denied: null,
    }),
    'fallback_instamart_app',
  );
  assert.equal(
    auditResultFor({
      placed: false,
      partialSuccess: false,
      fallback: false,
      recoveredAlreadyPlaced: true,
      denied: null,
    }),
    'recovered_order_already_placed',
  );
  assert.equal(
    auditResultFor({
      placed: false,
      partialSuccess: false,
      fallback: false,
      recoveredAlreadyPlaced: false,
      denied: 'disabled',
    }),
    'denied_disabled',
  );
  assert.equal(
    auditResultFor({
      placed: false,
      partialSuccess: false,
      fallback: false,
      recoveredAlreadyPlaced: false,
      denied: 'ineligible',
    }),
    'denied_ineligible',
  );
  assert.equal(
    auditResultFor({
      placed: false,
      partialSuccess: false,
      fallback: false,
      recoveredAlreadyPlaced: false,
      denied: 'stale_confirmation',
    }),
    'denied_stale_confirmation',
  );
});
