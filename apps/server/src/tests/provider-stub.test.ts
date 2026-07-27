import assert from 'node:assert/strict';
import test from 'node:test';
import { id } from '@cooklink/domain';
import { createStubProvider } from '../provider-stub.js';

/**
 * Issue 10, AC#8 — the local provider stub makes the complete product-matching
 * journey testable without production credentials. These tests run without
 * DATABASE_URL and exercise the stub's full contract: delegated OAuth,
 * address-scoped product search, cart preserve/replace, review shape, and
 * alternatives for unavailable products (AC#5).
 */

const USER = id<'UserId'>('u-stub-1');

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
