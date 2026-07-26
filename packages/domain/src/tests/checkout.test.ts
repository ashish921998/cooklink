import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCheckout,
  paymentSelection,
  shouldRetryCheckout,
  CART_VALUE_LIMIT_CENTS,
} from '../checkout.js';

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
  assert.equal(
    shouldRetryCheckout({ uncertainFailure: true, orderAlreadyPlaced: true }),
    false,
  );
  assert.equal(
    shouldRetryCheckout({ uncertainFailure: true, orderAlreadyPlaced: false }),
    true,
  );
  // a deterministic failure must not be retried blindly
  assert.equal(
    shouldRetryCheckout({ uncertainFailure: false, orderAlreadyPlaced: false }),
    false,
  );
});
