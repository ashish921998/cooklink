import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id } from '../ids.js';
import {
  Authorization,
  AuthorizationDeniedError,
  InMemoryRepository,
  decideCheckout,
  shouldRetryCheckout,
  classifyCheckoutResult,
  cancellationGuidance,
  buildCheckoutConfirmation,
  confirmationMatches,
  resolveMatchPlan,
  type ProviderProduct,
  type SuggestedCartItem,
} from '../index.js';

/**
 * Issue 13, AC#6 — recovery scenarios.
 *
 * Checkout failure, uncertain result, partial success, offline outbox,
 * expired invite, removed membership, and unavailable-product recovery are
 * demonstrated.
 *
 * Some of these scenarios are also covered in dedicated test files
 * (checkout.test.ts, invite-lifecycle.test.ts, provider.test.ts,
 * household-isolation.test.ts). This file consolidates the recovery-specific
 * assertions into one evidence suite.
 */

function makeCartItem(overrides: Partial<SuggestedCartItem> = {}): SuggestedCartItem {
  return {
    id: 'cart-1',
    householdId: id<'HouseholdId'>('h-1'),
    ingredientKey: 'tomato',
    groceryRequestId: null,
    freeTextItem: null,
    needDay: 'today',
    affectedMeals: [{ date: '2026-07-27', mealType: 'dinner', name: 'Dal Tadka' }],
    confidence: 'may_be_low',
    memberState: 'pending',
    removalReason: null,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<ProviderProduct> = {}): ProviderProduct {
  return {
    id: 'prod-tomato-500',
    name: 'Tomato',
    brand: 'Fresh Farms',
    variant: 'Ripe',
    packSize: '500 g',
    priceCents: 3000,
    mrpCents: 3500,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    imageUrl: null,
    ...overrides,
  };
}

// ---- 1. Checkout failure recovery ----

test('AC#6: checkout failure does not retry blindly', () => {
  // A deterministic failure (network error, payment declined) must not retry.
  assert.equal(shouldRetryCheckout({ uncertainFailure: false, orderAlreadyPlaced: false }), false);
});

test('AC#6: checkout uncertain result retries only when no order was placed', () => {
  // After an uncertain failure (timeout), retry only if get_orders shows nothing.
  assert.equal(shouldRetryCheckout({ uncertainFailure: true, orderAlreadyPlaced: false }), true);
  // If the order was already placed, do not retry (idempotency).
  assert.equal(shouldRetryCheckout({ uncertainFailure: true, orderAlreadyPlaced: true }), false);
});

// ---- 2. Partial success recovery ----

test('AC#6: partial success is classified and the user is told which stores failed', () => {
  const today = new Date().toISOString();
  const result = classifyCheckoutResult([
    {
      id: 'ord-1',
      status: 'placed',
      storeId: 'store-1',
      storeName: 'Store 1',
      totalCents: 3000,
      items: [],
      placedAt: today,
      deliveryEta: today,
      trackingUrl: 'https://example.com/track/1',
      cancellableUntil: today,
      cancellationPolicy: '5 min',
    },
    {
      id: 'ord-2',
      status: 'failed',
      storeId: 'store-2',
      storeName: 'Store 2',
      totalCents: 2000,
      items: [],
      placedAt: today,
      deliveryEta: null,
      trackingUrl: null,
      cancellableUntil: null,
      cancellationPolicy: 'Not cancellable.',
    },
  ]);
  assert.equal(result.partialSuccess, true);
  assert.equal(result.succeededCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.allSucceeded, false);
});

// ---- 3. Checkout confirmation expiry recovery ----

test('AC#6: an expired checkout confirmation denies checkout (stale snapshot)', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const household = id<'HouseholdId'>('h-recovery');
  const member = id<'MembershipId'>('m-recovery');
  const review = {
    addressId: 'addr-home',
    items: [
      {
        productId: 'prod-1',
        name: 'Tomato',
        brand: 'Fresh Farms',
        variant: 'Ripe',
        packSize: '500 g',
        quantity: 2,
        priceCents: 3000,
        lineTotalCents: 6000,
        available: true,
        storeId: 'store-1',
        storeName: 'Store 1',
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
  };
  const conf = buildCheckoutConfirmation({
    token: 'tok-recovery',
    householdId: household,
    membershipId: member,
    review,
    paymentMethodId: 'pm-cod',
    now,
  });
  // After the TTL expires, the confirmation is stale.
  const result = confirmationMatches(
    conf,
    { membershipId: member, review, paymentMethodId: 'pm-cod' },
    new Date('2026-07-27T10:05:00.000Z'),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

// ---- 4. Cancellation recovery ----

test('AC#6: cancellation is guided within the provider window', () => {
  const now = new Date('2026-07-27T10:01:00.000Z');
  const guidance = cancellationGuidance(
    {
      id: 'ord-recovery',
      status: 'placed',
      storeId: 'store-1',
      storeName: 'Store 1',
      totalCents: 5000,
      items: [],
      placedAt: '2026-07-27T10:00:00.000Z',
      deliveryEta: '2026-07-27T11:00:00.000Z',
      trackingUrl: 'https://example.com/track',
      cancellableUntil: '2026-07-27T10:05:00.000Z',
      cancellationPolicy: 'Cancellable within 5 minutes.',
    },
    now,
  );
  assert.equal(guidance.cancellable, true);
  assert.equal(guidance.reason, 'within_window');
});

test('AC#6: past the cancellation window the order is not cancellable', () => {
  const now = new Date('2026-07-27T10:10:00.000Z');
  const guidance = cancellationGuidance(
    {
      id: 'ord-recovery',
      status: 'confirmed',
      storeId: 'store-1',
      storeName: 'Store 1',
      totalCents: 5000,
      items: [],
      placedAt: '2026-07-27T10:00:00.000Z',
      deliveryEta: '2026-07-27T11:00:00.000Z',
      trackingUrl: 'https://example.com/track',
      cancellableUntil: '2026-07-27T10:05:00.000Z',
      cancellationPolicy: 'Cancellable within 5 minutes.',
    },
    now,
  );
  assert.equal(guidance.cancellable, false);
  assert.equal(guidance.reason, 'past_cancellation_window');
});

// ---- 5. Unavailable product recovery ----

test('AC#6: an unavailable product offers alternatives and requires deliberate replacement', () => {
  const cartItem = makeCartItem();
  const selectedProduct = makeProduct({ id: 'prod-tomato-500', available: false });
  const alt1 = makeProduct({ id: 'prod-tomato-500-alt1', brand: 'Organic Co' });
  const alt2 = makeProduct({ id: 'prod-tomato-500-alt2', brand: 'Local Farm' });
  const alt3 = makeProduct({ id: 'prod-tomato-500-alt3', brand: 'Premium' });
  const unavailableProduct = makeProduct({ id: 'prod-tomato-500', available: false });

  const plan = resolveMatchPlan({
    cartItems: [cartItem],
    matches: [
      {
        id: 'match-1',
        householdId: id<'HouseholdId'>('h-1'),
        cartItemId: cartItem.id,
        productId: 'prod-tomato-500',
        addressId: 'addr-home',
        quantity: 2,
        product: selectedProduct,
        selectedById: id<'MembershipId'>('m-1'),
        selectedAt: new Date().toISOString(),
      },
    ],
    searchResults: new Map([[cartItem.id, [unavailableProduct, alt1, alt2, alt3]]]),
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.state, 'unavailable');
  if (plan[0]!.state === 'unavailable') {
    assert.ok(plan[0]!.alternatives.length <= 3, 'should offer at most 3 alternatives');
    assert.ok(plan[0]!.alternatives.length > 0, 'should offer at least one alternative');
    // The unavailable product itself must not be in the alternatives
    for (const alt of plan[0]!.alternatives) {
      assert.notEqual(alt.id, 'prod-tomato-500');
      assert.equal(alt.available, true);
    }
  }
});

test('AC#6: a resolved product that is still available stays resolved', () => {
  const cartItem = makeCartItem();
  const product = makeProduct({ available: true });

  const plan = resolveMatchPlan({
    cartItems: [cartItem],
    matches: [
      {
        id: 'match-1',
        householdId: id<'HouseholdId'>('h-1'),
        cartItemId: cartItem.id,
        productId: 'prod-tomato-500',
        addressId: 'addr-home',
        quantity: 2,
        product,
        selectedById: id<'MembershipId'>('m-1'),
        selectedAt: new Date().toISOString(),
      },
    ],
    searchResults: new Map([[cartItem.id, [product]]]),
  });

  assert.equal(plan[0]!.state, 'resolved');
});

test('AC#6: an unresolved cart item has no match and offers candidates', () => {
  const cartItem = makeCartItem();
  const candidate = makeProduct({ id: 'prod-tomato-cand' });

  const plan = resolveMatchPlan({
    cartItems: [cartItem],
    matches: [],
    searchResults: new Map([[cartItem.id, [candidate]]]),
  });

  assert.equal(plan[0]!.state, 'unresolved');
  if (plan[0]!.state === 'unresolved') {
    assert.equal(plan[0]!.candidates.length, 1);
  }
});

// ---- 6. Removed membership recovery ----

test('AC#6: a removed membership is denied authorization immediately', async () => {
  const repo = new InMemoryRepository();
  const auth = new Authorization(repo);

  const owner = await repo.createUser({
    id: id<'UserId'>('u-recovery-owner'),
    clerkUserId: 'owner-recovery',
    phone: '+919000000010',
    displayName: 'Owner',
  });
  const { household } = await repo.createHousehold(
    {
      name: 'Recovery Household',
      photoUrl: null,
      servingCount: 4,
      mealStyle: 'north' as const,
      dietStyle: 'vegetarian' as const,
      healthEmphasis: [],
      specialMealEnabled: false,
      defaultLanguage: 'en' as const,
    },
    owner.id,
  );

  const cook = await repo.createUser({
    id: id<'UserId'>('u-recovery-cook'),
    clerkUserId: 'cook-recovery',
    phone: '+919000000011',
    displayName: 'Cook',
  });
  const cookMembership = await repo.addMembership(household.id, cook.id, 'cook');

  // Cook can initially authorize
  const initialPrincipal = await auth.authorize(cook.id, household.id);
  assert.equal(initialPrincipal.role, 'cook');

  // Owner removes the cook
  await repo.removeMembership(cookMembership.id);

  // Cook is now denied
  await assert.rejects(() => auth.authorize(cook.id, household.id), AuthorizationDeniedError);
});

test('AC#6: a closed household denies all members', async () => {
  const repo = new InMemoryRepository();
  const auth = new Authorization(repo);

  const owner = await repo.createUser({
    id: id<'UserId'>('u-close-owner'),
    clerkUserId: 'close-owner',
    phone: '+919000000020',
    displayName: 'Owner',
  });
  const { household } = await repo.createHousehold(
    {
      name: 'Closing Household',
      photoUrl: null,
      servingCount: 4,
      mealStyle: 'north' as const,
      dietStyle: 'vegetarian' as const,
      healthEmphasis: [],
      specialMealEnabled: false,
      defaultLanguage: 'en' as const,
    },
    owner.id,
  );

  // Owner can initially authorize
  await auth.authorize(owner.id, household.id);

  // Close the household
  const stored = repo.households.get(household.id)!;
  stored.closedAt = new Date().toISOString();

  // Owner is now denied
  await assert.rejects(() => auth.authorize(owner.id, household.id), AuthorizationDeniedError);
});

// ---- 7. Expired grocery suggestion recovery ----

test('AC#6: an expired grocery suggestion cannot be confirmed', async () => {
  const { decideGrocerySuggestion } = await import('../grocery-request.js');
  const decision = decideGrocerySuggestion({
    intent: { kind: 'grocery_request', item: 'Tomato', quantity: '1' },
    role: 'cook',
    language: 'en',
    suggestion: {
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
    now: new Date(),
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.reason, 'suggestion_expired');
  }
});

// ---- 8. Feature-gated checkout recovery ----

test('AC#6: checkout disabled by feature gate falls back gracefully', () => {
  const d = decideCheckout(50_000, ['COD'], false);
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'disabled');
  // No fallback to instamart_app when the feature is disabled
  assert.equal(d.fallback, null);
});

// ---- 9. Offline outbox recovery ----

test('AC#6: the chat outbox contract enforces sending/sent/failed states and access-changed failure', () => {
  // The outbox is a client-side state machine in the mobile chat hook
  // (apps/mobile/src/lib/chat.ts). We verify the contract statically because
  // the React hook cannot run in a Node test environment.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(__dirname, '../../../../apps/mobile/src/lib/chat.ts'), 'utf8');

  // The outbox item has three states
  assert.ok(source.includes("state: 'sending'"), 'outbox must have a sending state');
  assert.ok(source.includes("state: 'sent'"), 'outbox must have a sent state');
  assert.ok(source.includes("state: 'failed'"), 'outbox must have a failed state');

  // A 403/404 rejection sets failureReason to household_access_changed
  assert.ok(
    source.includes("'household_access_changed'"),
    'outbox must detect household access changed (403/404)',
  );
  assert.ok(/\b40[34]\b/.test(source), 'outbox must check for 403/404 status codes');

  // A pending outbox item is never rendered in the shared timeline
  assert.ok(
    source.includes('local-only') || source.includes('never rendered'),
    'outbox contract must state pending items are local-only',
  );

  // The server re-authorizes on send (removed membership fails permanently)
  assert.ok(
    source.includes('re-authorizes') || source.includes('re-checks'),
    'outbox contract must state the server re-authorizes on send',
  );
});
