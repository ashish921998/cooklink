import assert from 'node:assert/strict';
import test from 'node:test';
import { brandId } from '@cooklink/domain';
import { createStubProvider } from '../provider-stub.js';

/**
 * Issue 10, AC#8 — the local provider stub makes the complete product-matching
 * journey testable without production credentials. These tests run without
 * DATABASE_URL and exercise the stub's full contract: delegated OAuth,
 * address-scoped product search, cart preserve/replace, review shape, and
 * alternatives for unavailable products (AC#5).
 */

const USER = brandId<'UserId'>('u-stub-1');

async function connect(provider: ReturnType<typeof createStubProvider>) {
  const start = await provider.startOAuth({
    memberUserId: USER,
    redirectUri: 'https://cooklink.app/callback',
  });
  await provider.completeOAuth({
    memberUserId: USER,
    code: 'stub-code',
    state: start.state,
  });
}

test('stub provider: not connected before OAuth', async () => {
  const provider = createStubProvider();
  const status = await provider.getConnectionStatus(USER);
  assert.equal(status.connected, false);
  assert.equal(status.expiresAt, null);
});

test('stub provider: delegated OAuth connect flow', async () => {
  const provider = createStubProvider();
  const start = await provider.startOAuth({
    memberUserId: USER,
    redirectUri: 'https://cooklink.app/callback',
  });
  assert.ok(start.authorizationUrl.includes('swiggy.com'));
  assert.ok(start.state);

  const result = await provider.completeOAuth({
    memberUserId: USER,
    code: 'stub-code',
    state: start.state,
  });
  assert.equal(result.connected, true);

  const status = await provider.getConnectionStatus(USER);
  assert.equal(status.connected, true);
  assert.ok(status.expiresAt);
});

test('stub provider: addresses require connection', async () => {
  const provider = createStubProvider();
  await assert.rejects(
    () => provider.getAddresses(USER),
    (err: Error) => err.message.includes('not connected'),
  );
});

test('stub provider: search is scoped to address and returns exact products', async () => {
  const provider = createStubProvider();
  await connect(provider);
  const addresses = await provider.getAddresses(USER);
  const homeAddr = addresses.find((a) => a.id === 'addr-home')!;
  assert.ok(homeAddr);

  const products = await provider.searchProducts({
    memberUserId: USER,
    addressId: 'addr-home',
    query: 'tomato',
  });
  assert.ok(products.length > 0);
  // AC#2 — each product has brand, pack size, price, availability.
  for (const p of products) {
    assert.ok(p.brand);
    assert.ok(p.packSize);
    assert.ok(typeof p.priceCents === 'number');
    assert.ok(typeof p.available === 'boolean');
    assert.equal(p.addressId, 'addr-home');
  }
});

test('stub provider: search returns empty for unknown address', async () => {
  const provider = createStubProvider();
  await connect(provider);
  const products = await provider.searchProducts({
    memberUserId: USER,
    addressId: 'addr-nonexistent',
    query: 'tomato',
  });
  assert.equal(products.length, 0);
});

test('stub provider: empty cart returns null review', async () => {
  const provider = createStubProvider();
  await connect(provider);
  const review = await provider.getCart(USER, 'addr-home');
  assert.equal(review, null);
});

test('stub provider: clearCart removes every item', async () => {
  const provider = createStubProvider();
  await connect(provider);
  await provider.updateCart({
    memberUserId: USER,
    addressId: 'addr-home',
    items: [{ productId: 'prod-tomato-500', quantity: 1 }],
  });
  await provider.clearCart(USER, 'addr-home');
  assert.equal(await provider.getCart(USER, 'addr-home'), null);
});

test('stub provider: updateCart builds a review with bill and payment methods', async () => {
  const provider = createStubProvider();
  await connect(provider);
  const review = await provider.updateCart({
    memberUserId: USER,
    addressId: 'addr-home',
    items: [{ productId: 'prod-tomato-500', quantity: 2 }],
  });
  assert.equal(review.items.length, 1);
  assert.equal(review.items[0]!.quantity, 2);
  assert.equal(review.items[0]!.lineTotalCents, 6000);
  assert.ok(review.bill.length > 0);
  assert.ok(review.totalCents > 0);
  assert.ok(review.availablePaymentMethods.length > 0);
  assert.ok(review.storeCount >= 1);
});

test('stub provider: AC#5 alternatives for unavailable product', async () => {
  const provider = createStubProvider({ availabilityOverrides: { 'prod-toordal-500': false } });
  await connect(provider);
  const alts = await provider.getAlternatives({
    memberUserId: USER,
    addressId: 'addr-home',
    productId: 'prod-toordal-500',
  });
  assert.ok(alts.length > 0);
  assert.ok(alts.length <= 3);
  for (const a of alts) {
    assert.ok(a.available);
    assert.notEqual(a.id, 'prod-toordal-500');
  }
});

test('stub provider: availability override makes a product unavailable', async () => {
  const provider = createStubProvider({ availabilityOverrides: { 'prod-tomato-500': false } });
  await connect(provider);
  const products = await provider.searchProducts({
    memberUserId: USER,
    addressId: 'addr-home',
    query: 'tomato',
  });
  const tomato500 = products.find((p) => p.id === 'prod-tomato-500');
  assert.ok(tomato500);
  assert.equal(tomato500!.available, false);
});

test('stub provider: disconnect clears the session', async () => {
  const provider = createStubProvider();
  await connect(provider);
  await provider.disconnect(USER);
  const status = await provider.getConnectionStatus(USER);
  assert.equal(status.connected, false);
});

// ---- issue 11: place_order + get_orders + recovery ----

async function buildCart(
  provider: ReturnType<typeof createStubProvider>,
  items: { productId: string; quantity: number }[],
) {
  await provider.updateCart({ memberUserId: USER, addressId: 'addr-home', items });
}

test('stub provider: placeOrder returns one order per store (multi-store, AC#7)', async () => {
  const provider = createStubProvider();
  await connect(provider);
  // Tomato (store-1) + Toor Dal 500g (store-2) → two stores.
  await buildCart(provider, [
    { productId: 'prod-tomato-500', quantity: 2 },
    { productId: 'prod-toordal-500', quantity: 1 },
  ]);
  const result = await provider.placeOrder({
    memberUserId: USER,
    addressId: 'addr-home',
    paymentMethodId: 'pm-cod',
    idempotencyKey: 'key-1',
  });
  assert.equal(result.orders.length, 2);
  assert.equal(result.allSucceeded, true);
  assert.equal(result.partialSuccess, false);
  const storeIds = new Set(result.orders.map((o) => o.storeId));
  assert.equal(storeIds.size, 2);
  for (const o of result.orders) {
    assert.equal(o.status, 'placed');
    assert.ok(o.trackingUrl);
    assert.ok(o.cancellableUntil);
    assert.ok(o.cancellationPolicy);
  }
});

test('stub provider: placeOrder reports partial success when a store fails (AC#7)', async () => {
  const provider = createStubProvider({ simulateMultiStorePartialFailure: true });
  await connect(provider);
  await buildCart(provider, [
    { productId: 'prod-tomato-500', quantity: 2 },
    { productId: 'prod-toordal-500', quantity: 1 },
  ]);
  const result = await provider.placeOrder({
    memberUserId: USER,
    addressId: 'addr-home',
    paymentMethodId: 'pm-cod',
    idempotencyKey: 'key-partial',
  });
  assert.equal(result.orders.length, 2);
  assert.equal(result.partialSuccess, true);
  assert.equal(result.allSucceeded, false);
  const statuses = result.orders.map((o) => o.status).sort();
  assert.deepEqual(statuses, ['failed', 'placed']);
});

test('stub provider: a repeated idempotency key never places a second order (AC#5)', async () => {
  const provider = createStubProvider();
  await connect(provider);
  await buildCart(provider, [{ productId: 'prod-tomato-500', quantity: 1 }]);
  const first = await provider.placeOrder({
    memberUserId: USER,
    addressId: 'addr-home',
    paymentMethodId: 'pm-cod',
    idempotencyKey: 'key-dedup',
  });
  const second = await provider.placeOrder({
    memberUserId: USER,
    addressId: 'addr-home',
    paymentMethodId: 'pm-cod',
    idempotencyKey: 'key-dedup',
  });
  // The second call returns the same order ids — no duplicate placement.
  assert.deepEqual(second.orders.map((o) => o.id).sort(), first.orders.map((o) => o.id).sort());
  const orders = await provider.getOrders(USER);
  assert.equal(orders.length, 1);
});

test('stub provider: upstream uncertainty throws but the order is visible via get_orders (AC#6)', async () => {
  const provider = createStubProvider({ failPlaceOrderOnAttempt: 1 });
  await connect(provider);
  await buildCart(provider, [{ productId: 'prod-tomato-500', quantity: 1 }]);
  await assert.rejects(
    () =>
      provider.placeOrder({
        memberUserId: USER,
        addressId: 'addr-home',
        paymentMethodId: 'pm-cod',
        idempotencyKey: 'key-uncertain',
      }),
    (err: Error) => err.message.includes('verify via get_orders'),
  );
  // Recovery: get_orders shows the order was actually placed → never retry.
  const orders = await provider.getOrders(USER);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.status, 'placed');
});

test('stub provider: placeOrder rejects an empty cart', async () => {
  const provider = createStubProvider();
  await connect(provider);
  await assert.rejects(
    () =>
      provider.placeOrder({
        memberUserId: USER,
        addressId: 'addr-home',
        paymentMethodId: 'pm-cod',
        idempotencyKey: 'key-empty',
      }),
    /Cart is empty/,
  );
});

test('stub provider: placeOrder rejects a payment method the provider did not return', async () => {
  const provider = createStubProvider();
  await connect(provider);
  await buildCart(provider, [{ productId: 'prod-tomato-500', quantity: 1 }]);
  await assert.rejects(
    () =>
      provider.placeOrder({
        memberUserId: USER,
        addressId: 'addr-home',
        paymentMethodId: 'pm-bogus',
        idempotencyKey: 'key-badpm',
      }),
    /Payment method not available/,
  );
});

test('stub provider: getOrders requires connection and returns live tracking (AC#8)', async () => {
  const provider = createStubProvider();
  await connect(provider);
  await buildCart(provider, [{ productId: 'prod-tomato-500', quantity: 1 }]);
  await provider.placeOrder({
    memberUserId: USER,
    addressId: 'addr-home',
    paymentMethodId: 'pm-cod',
    idempotencyKey: 'key-track',
  });
  const orders = await provider.getOrders(USER);
  assert.equal(orders.length, 1);
  assert.ok(orders[0]!.trackingUrl);
  assert.ok(orders[0]!.deliveryEta);
  assert.ok(orders[0]!.cancellationPolicy);
  // The internal _key tag must not leak to callers.
  assert.equal((orders[0] as unknown as { _key?: string })._key, undefined);
});

test('stub provider: getOrders before connecting is rejected', async () => {
  const provider = createStubProvider();
  await assert.rejects(
    () => provider.getOrders(USER),
    (err: Error) => err.message.includes('not connected'),
  );
});
