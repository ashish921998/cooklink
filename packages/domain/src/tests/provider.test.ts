import assert from 'node:assert/strict';
import test from 'node:test';
import { id } from '../ids.js';
import {
  resolveMatchPlan,
  orderableCartItems,
  buildCartUpdatePlan,
  validateCartReview,
  allResolved,
  searchQueryFor,
  type ProductMatch,
  type ProviderProduct,
  type ProviderCartReview,
} from '../provider.js';
import type { SuggestedCartItem } from '../types.js';

/**
 * Issue 10 — pure domain tests for the Instamart product-matching journey.
 *
 * These cover: a vague need stays unresolved until the Member chooses an exact
 * product (AC#3); a selected product that becomes unavailable offers up to
 * three alternatives (AC#5); cart preserve-or-replace is deliberate (AC#4);
 * the review validation checks every required field (AC#6); and allResolved
 * gates checkout on every line being resolved.
 */

const HOUSEHOLD = id<'HouseholdId'>('h-1');
const MEMBER = id<'MembershipId'>('m-1');

function makeCartItem(overrides: Partial<SuggestedCartItem> = {}): SuggestedCartItem {
  return {
    id: 'cart-tomato',
    householdId: HOUSEHOLD,
    ingredientKey: 'tomato',
    groceryRequestId: null,
    freeTextItem: null,
    needDay: 'today',
    affectedMeals: [],
    confidence: 'may_be_low',
    memberState: 'kept',
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

function makeMatch(overrides: Partial<ProductMatch> = {}): ProductMatch {
  return {
    id: 'match-1',
    householdId: HOUSEHOLD,
    cartItemId: 'cart-tomato',
    productId: 'prod-tomato-500',
    addressId: 'addr-home',
    quantity: 2,
    product: makeProduct(),
    selectedById: MEMBER,
    selectedAt: '2026-01-10T10:00:00.000Z',
    ...overrides,
  };
}

// ---- AC#3: a vague need stays unresolved until a product is chosen ----

test('resolveMatchPlan: unresolved when no product chosen', () => {
  const cartItems = [makeCartItem()];
  const plan = resolveMatchPlan({
    cartItems,
    matches: [],
    searchResults: new Map([
      ['cart-tomato', [makeProduct(), makeProduct({ id: 'prod-tomato-1kg' })]],
    ]),
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.state, 'unresolved');
  if (plan[0]!.state === 'unresolved') {
    assert.equal(plan[0]!.candidates.length, 2);
  }
});

test('orderableCartItems: excludes pending and removed lines', () => {
  const items = orderableCartItems([
    makeCartItem({ id: 'kept', memberState: 'kept' }),
    makeCartItem({ id: 'pending', memberState: 'pending' }),
    makeCartItem({ id: 'removed', memberState: 'removed', removalReason: 'already_have' }),
  ]);
  assert.deepEqual(
    items.map((item) => item.id),
    ['kept'],
  );
});

test('resolveMatchPlan: resolved when a product is chosen and available', () => {
  const cartItems = [makeCartItem()];
  const match = makeMatch();
  const plan = resolveMatchPlan({
    cartItems,
    matches: [match],
    searchResults: new Map(),
  });
  assert.equal(plan[0]!.state, 'resolved');
});

test('resolveMatchPlan: unavailable when the chosen product became unavailable', () => {
  const cartItems = [makeCartItem()];
  const match = makeMatch({
    product: makeProduct({ available: false }),
  });
  const alt1 = makeProduct({ id: 'prod-tomato-1kg' });
  const alt2 = makeProduct({ id: 'prod-tomato-cherry', name: 'Cherry Tomato' });
  const alt3 = makeProduct({ id: 'prod-tomato-organic', variant: 'Organic' });
  const alt4 = makeProduct({ id: 'prod-tomato-imported' });
  const plan = resolveMatchPlan({
    cartItems,
    matches: [match],
    searchResults: new Map([['cart-tomato', [alt1, alt2, alt3, alt4]]]),
  });
  assert.equal(plan[0]!.state, 'unavailable');
  if (plan[0]!.state === 'unavailable') {
    // AC#5 — up to three alternatives.
    assert.equal(plan[0]!.alternatives.length, 3);
  }
});

test('resolveMatchPlan: unavailable offers fewer alternatives when fewer exist', () => {
  const cartItems = [makeCartItem()];
  const match = makeMatch({ product: makeProduct({ available: false }) });
  const plan = resolveMatchPlan({
    cartItems,
    matches: [match],
    searchResults: new Map([['cart-tomato', [makeProduct({ id: 'alt-1' })]]]),
  });
  assert.equal(plan[0]!.state, 'unavailable');
  if (plan[0]!.state === 'unavailable') {
    assert.equal(plan[0]!.alternatives.length, 1);
  }
});

test('allResolved: false when any line is unresolved', () => {
  const plan = resolveMatchPlan({
    cartItems: [makeCartItem(), makeCartItem({ id: 'cart-onion', ingredientKey: 'onion' })],
    matches: [makeMatch()],
    searchResults: new Map(),
  });
  assert.equal(allResolved(plan), false);
});

test('allResolved: true when all lines are resolved', () => {
  const plan = resolveMatchPlan({
    cartItems: [makeCartItem()],
    matches: [makeMatch()],
    searchResults: new Map(),
  });
  assert.equal(allResolved(plan), true);
});

// ---- AC#4: cart preserve-or-replace is deliberate ----

test('buildCartUpdatePlan: replace mode drops all current items', () => {
  const currentItems = [
    {
      productId: 'existing-1',
      name: 'Something',
      brand: 'Brand',
      variant: null,
      packSize: '1 kg',
      quantity: 1,
      priceCents: 1000,
      lineTotalCents: 1000,
      available: true,
      storeId: 'store-1',
      storeName: 'Store 1',
    },
  ];
  const intended = [
    { productId: 'prod-tomato-500', quantity: 2 },
    { productId: 'prod-onion-500', quantity: 1 },
  ];
  const result = buildCartUpdatePlan({
    currentItems,
    intendedItems: intended,
    mode: 'replace',
  });
  assert.equal(result.preservedCount, 0);
  assert.equal(result.replacedCount, 1);
  assert.equal(result.items.length, 2);
});

test('buildCartUpdatePlan: preserve mode keeps unrelated current items', () => {
  const currentItems = [
    {
      productId: 'existing-unrelated',
      name: 'Something Else',
      brand: 'Brand',
      variant: null,
      packSize: '1 kg',
      quantity: 3,
      priceCents: 1000,
      lineTotalCents: 3000,
      available: true,
      storeId: 'store-1',
      storeName: 'Store 1',
    },
  ];
  const intended = [{ productId: 'prod-tomato-500', quantity: 2 }];
  const result = buildCartUpdatePlan({
    currentItems,
    intendedItems: intended,
    mode: 'preserve',
  });
  assert.equal(result.preservedCount, 1);
  assert.equal(result.replacedCount, 0);
  assert.equal(result.items.length, 2);
  // The unrelated item is kept.
  assert.ok(result.items.some((i) => i.productId === 'existing-unrelated' && i.quantity === 3));
  // The intended item is added.
  assert.ok(result.items.some((i) => i.productId === 'prod-tomato-500' && i.quantity === 2));
});

test('buildCartUpdatePlan: preserve mode updates quantity for overlapping items', () => {
  const currentItems = [
    {
      productId: 'prod-tomato-500',
      name: 'Tomato',
      brand: 'Fresh Farms',
      variant: 'Ripe',
      packSize: '500 g',
      quantity: 1,
      priceCents: 3000,
      lineTotalCents: 3000,
      available: true,
      storeId: 'store-1',
      storeName: 'Store 1',
    },
  ];
  const intended = [{ productId: 'prod-tomato-500', quantity: 5 }];
  const result = buildCartUpdatePlan({
    currentItems,
    intendedItems: intended,
    mode: 'preserve',
  });
  // Overlapping item is NOT preserved from current; the intended quantity wins.
  assert.equal(result.preservedCount, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.quantity, 5);
});

// ---- AC#6: review validation ----

test('validateCartReview: valid when all required fields present', () => {
  const review: ProviderCartReview = {
    addressId: 'addr-home',
    items: [
      {
        productId: 'p1',
        name: 'Tomato',
        brand: 'Brand',
        variant: null,
        packSize: '500 g',
        quantity: 2,
        priceCents: 3000,
        lineTotalCents: 6000,
        available: true,
        storeId: 's1',
        storeName: 'Store 1',
      },
    ],
    bill: [{ label: 'Item total', amountCents: 6000 }],
    totalCents: 6000,
    availablePaymentMethods: [{ id: 'pm-cod', label: 'COD', kind: 'COD' }],
    storeCount: 1,
    hasUnavailableItems: false,
  };
  const result = validateCartReview(review);
  assert.equal(result.valid, true);
  assert.equal(result.missing.length, 0);
});

test('validateCartReview: invalid when items missing', () => {
  const review: ProviderCartReview = {
    addressId: 'addr-home',
    items: [],
    bill: [{ label: 'Item total', amountCents: 0 }],
    totalCents: 0,
    availablePaymentMethods: [],
    storeCount: 0,
    hasUnavailableItems: false,
  };
  const result = validateCartReview(review);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes('items'));
  assert.ok(result.missing.includes('store_count'));
});

// ---- searchQueryFor ----

test('searchQueryFor: uses free text when present (Cook request)', () => {
  const item = makeCartItem({ ingredientKey: null, freeTextItem: '2 kg red onions' });
  assert.equal(searchQueryFor(item), '2 kg red onions');
});

test('searchQueryFor: uses ingredient key humanized when no free text', () => {
  const item = makeCartItem({ ingredientKey: 'toor_dal', freeTextItem: null });
  assert.equal(searchQueryFor(item), 'toor dal');
});

test('searchQueryFor: empty string when neither key nor free text', () => {
  const item = makeCartItem({ ingredientKey: null, freeTextItem: null });
  assert.equal(searchQueryFor(item), '');
});
