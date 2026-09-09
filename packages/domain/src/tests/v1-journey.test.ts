import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandId, type RecipeId } from '../ids.js';
import {
  Authorization,
  InMemoryRepository,
  generateStarterPlan,
  decideGrocerySuggestion,
  cookMayMutate,
  buildSuggestedCart,
  decideCheckout,
  classifyCheckoutResult,
  cancellationGuidance,
  can,
} from '../index.js';
import type { Recipe } from '../domain-types.js';

/**
 * Issue 13, AC#1 — the end-to-end V1 journey proven at the domain layer.
 *
 * This test drives the complete Household lifecycle: Owner creates a
 * Household, the plan generates immediately, a Cook is invited and joins,
 * the Cook sends a grocery Chat message that becomes a Member-approved
 * Grocery Request, the request flows into the Suggested Cart, the cart
 * reaches a checkout decision, the checkout outcome is classified, and the
 * cancellation guidance follows the provider contract.
 *
 * The MySQL-backed server tests prove the same journey through Hono; this
 * test proves the domain logic itself works end to end without a database.
 */

function makeHousehold() {
  return {
    name: 'Sharma Family',
    photoUrl: null,
    servingCount: 4,
    mealStyle: 'north' as const,
    dietStyle: 'vegetarian' as const,
    healthEmphasis: [],
    specialMealEnabled: false,
    defaultLanguage: 'en' as const,
  };
}

const recipeDalTadka: Recipe = {
  id: brandId<'RecipeId'>('r-dal-tadka'),
  name: 'Dal Tadka',
  nameHi: 'दाल तड़का',
  baseServings: 4,
  dietStyle: 'vegetarian',
  mealStyle: 'north',
  mealTypes: ['lunch', 'dinner'],
  provenance: 'verified',
  ingredients: [
    {
      name: 'Toor dal',
      ingredientKey: 'toor_dal',
      quantity: 200,
      unit: 'g',
      dependable: true,
      adjustToTaste: false,
    },
    {
      name: 'Tomato',
      ingredientKey: 'tomato',
      quantity: 3,
      unit: 'count',
      dependable: true,
      adjustToTaste: false,
    },
  ],
  steps: ['Boil dal', 'Add tadka'],
  stepsHi: ['दाल उबालें', 'तड़का डालें'],
};

test('AC#1: the full V1 Owner-to-checkout journey', async () => {
  const repo = new InMemoryRepository();
  const auth = new Authorization(repo);

  // ---- Owner creates Household ----
  const owner = await repo.createUser({
    id: brandId<'UserId'>('u-owner'),
    clerkUserId: 'owner-clerk',
    phone: '+919000000001',
    displayName: 'Meera',
  });
  const { household, ownerMembership } = await repo.createHousehold(makeHousehold(), owner.id);
  assert.ok(household.id);
  assert.equal(ownerMembership.role, 'owner');
  assert.equal(ownerMembership.status, 'active');

  // ---- Plan generates immediately (21 meals, 7 days x 3) ----
  const today = new Date().toISOString().slice(0, 10);
  const plan = generateStarterPlan(today, {
    dietStyle: household.dietStyle,
    mealStyle: household.mealStyle,
    servings: household.servingCount,
    specialMealEnabled: household.specialMealEnabled,
  });
  assert.equal(plan.length, 21);
  for (const meal of plan) {
    await repo.upsertPlannedMeal(
      household.id,
      { ...meal, recipeId: meal.recipeId as RecipeId | null },
      ownerMembership.id,
    );
  }
  const mealsToday = await repo.listMealsForDay(household.id, today);
  assert.equal(mealsToday.length, 3);

  // ---- Cook joins ----
  const cookUser = await repo.createUser({
    id: brandId<'UserId'>('u-cook'),
    clerkUserId: 'cook-clerk',
    phone: '+919000000002',
    displayName: 'Raju',
  });
  const cookMembership = await repo.addMembership(household.id, cookUser.id, 'cook');
  assert.equal(cookMembership.role, 'cook');
  assert.equal(cookMembership.notificationDefault, 'important');

  // ---- Cook can mutate meals; a Cook can mutate pending grocery requests ----
  assert.equal(can(cookMembership.role, 'edit_meal_plan'), true);
  assert.equal(cookMayMutate('pending'), true);
  assert.equal(cookMayMutate('approved'), false);

  // ---- Cook sends a grocery Chat message ----
  const cookMsg = await repo.createMessage(household.id, {
    senderId: cookMembership.id,
    kind: 'text',
    body: 'नारियल चाहिए',
    caption: null,
    mediaRef: null,
    clientCreatedAt: new Date().toISOString(),
  });
  assert.ok(cookMsg.id);

  // ---- The message intent becomes a Member-approved Grocery Request ----
  const suggestion = decideGrocerySuggestion({
    intent: { kind: 'grocery_request', item: 'नारियल', quantity: null },
    role: 'cook',
    language: 'hi',
    suggestion: {
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    now: new Date(),
  });
  assert.equal(suggestion.ok, true);
  if (suggestion.ok) {
    assert.equal(suggestion.action, 'create_grocery_request');
  }

  // The owner authorizes the grocery request creation
  const ownerPrincipal = await auth.authorize(owner.id, household.id);
  assert.equal(can(ownerPrincipal.role, 'approve_reject_request'), true);

  const { request } = await repo.createGroceryRequest(
    household.id,
    { itemText: 'नारियल', quantityText: '2' },
    cookMembership.id,
  );
  assert.equal(request.status, 'pending');

  // Owner approves
  await repo.updateGroceryRequest(
    household.id,
    request.id,
    request.version,
    { status: 'approved', resolvedById: ownerMembership.id },
    ownerMembership.id,
  );
  const approved = await repo.getGroceryRequest(request.id);
  assert.equal(approved!.status, 'approved');

  // ---- The approved request flows into the Suggested Cart ----
  await repo.upsertPlannedMeal(
    household.id,
    {
      date: today,
      mealType: 'dinner',
      recipeId: recipeDalTadka.id,
      name: 'Dal Tadka',
      servings: 4,
      servingsOverridden: false,
      isSpecial: false,
    },
    cookMembership.id,
  );

  const cart = buildSuggestedCart({
    today,
    meals: await repo.listMealsForDay(household.id, today),
    recipesById: new Map([[recipeDalTadka.id, recipeDalTadka]]),
    pantryByIngredient: new Map(),
    approvedRequests: [approved!],
  });
  assert.ok(cart.length >= 1);
  assert.ok(cart.some((c) => c.groceryRequestId === approved!.id));

  // ---- Checkout decision: below limit with payment method is eligible ----
  const checkoutDecision = decideCheckout(50_000, ['COD'], true);
  assert.equal(checkoutDecision.eligible, true);
  assert.equal(checkoutDecision.reason, 'eligible');

  // ---- Checkout decision: over limit falls back to Instamart app ----
  const overLimit = decideCheckout(100_000, ['COD'], true);
  assert.equal(overLimit.eligible, false);
  assert.equal(overLimit.fallback, 'instamart_app');

  // ---- Checkout decision: ordering disabled by feature gate ----
  const gated = decideCheckout(50_000, ['COD'], false);
  assert.equal(gated.eligible, false);
  assert.equal(gated.reason, 'disabled');

  // ---- Multi-store partial success is classified per order ----
  const partial = classifyCheckoutResult([
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
  assert.equal(partial.allSucceeded, false);
  assert.equal(partial.partialSuccess, true);
  assert.equal(partial.succeededCount, 1);
  assert.equal(partial.failedCount, 1);

  // ---- Cancellation guidance follows the provider contract ----
  const guidance = cancellationGuidance(
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
      cancellableUntil: new Date(Date.now() + 300_000).toISOString(),
      cancellationPolicy: 'Cancellable within 5 minutes.',
    },
    new Date(),
  );
  assert.equal(guidance.cancellable, true);
  assert.equal(guidance.reason, 'within_window');
});

test('AC#1: a Cook is denied checkout and cart edit capabilities', async () => {
  const repo = new InMemoryRepository();
  const auth = new Authorization(repo);

  const owner = await repo.createUser({
    id: brandId<'UserId'>('u-owner2'),
    clerkUserId: 'owner2-clerk',
    phone: '+919000000003',
    displayName: 'Owner2',
  });
  const { household } = await repo.createHousehold(makeHousehold(), owner.id);
  const cookUser = await repo.createUser({
    id: brandId<'UserId'>('u-cook2'),
    clerkUserId: 'cook2-clerk',
    phone: '+919000000004',
    displayName: 'Cook2',
  });
  await repo.addMembership(household.id, cookUser.id, 'cook');

  const cookPrincipal = await auth.authorize(cookUser.id, household.id);
  assert.equal(can(cookPrincipal.role, 'review_place_order'), false);
  assert.equal(can(cookPrincipal.role, 'add_to_cart'), false);
  assert.equal(can(cookPrincipal.role, 'approve_reject_request'), false);

  const ownerPrincipal = await auth.authorize(owner.id, household.id);
  assert.equal(can(ownerPrincipal.role, 'review_place_order'), true);
  assert.equal(can(ownerPrincipal.role, 'add_to_cart'), true);
});
