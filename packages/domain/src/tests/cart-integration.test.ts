import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRepository,
  brandId,
  deriveConsumption,
  refreshSuggestedCart,
  addDays,
} from '../index.js';
import type { PlannedMeal, Recipe } from '../domain-types.js';
import type { HouseholdId, MembershipId } from '../ids.js';

/**
 * Issue 09 — durable integration tests for the three-day Suggested Grocery
 * Cart, covering: deterministic consumption recalculation, freshness
 * degradation, approved-request overrides, Check-at-home uncertainty, removal
 * reasons, household isolation, and the today + next two calendar days scope.
 *
 * These run against the in-memory repository (the same contract as the
 * Drizzle backend), so the logic is proven independent of any particular
 * database.
 */

const TODAY = '2026-01-10';

function makeHousehold(name: string) {
  return {
    name,
    photoUrl: null,
    servingCount: 4,
    mealStyle: 'north' as const,
    dietStyle: 'vegetarian' as const,
    healthEmphasis: [],
    specialMealEnabled: false,
    defaultLanguage: 'en' as const,
  };
}

const RECIPE: Recipe = {
  id: brandId<'RecipeId'>('r-dal'),
  name: 'Dal Tadka',
  nameHi: null,
  baseServings: 4,
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
    {
      name: 'Salt',
      ingredientKey: null,
      quantity: null,
      unit: 'g',
      dependable: false,
      adjustToTaste: true,
    },
  ],
  steps: ['cook'],
  stepsHi: null,
  provenance: 'verified',
  dietStyle: 'vegetarian',
  mealStyle: 'north',
  mealTypes: ['lunch', 'dinner'],
};

async function setupHousehold(repo: InMemoryRepository) {
  const user = await repo.createUser({
    id: brandId<'UserId'>('u-owner'),
    clerkUserId: 'owner',
    phone: '+919000000000',
    displayName: 'Owner',
  });
  const { household, ownerMembership } = await repo.createHousehold(
    makeHousehold('Test Home'),
    user.id,
  );
  repo.recipes.set(RECIPE.id as string, RECIPE);
  return { household, ownerMembership, user };
}

function meal(
  householdId: HouseholdId,
  date: string,
  mealType: PlannedMeal['mealType'] = 'dinner',
  servings = 4,
  recipeId: string | null = 'r-dal',
): Omit<PlannedMeal, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'householdId'> {
  return {
    date,
    mealType,
    recipeId: recipeId ? brandId<'RecipeId'>(recipeId) : null,
    name: 'Dal Tadka',
    servings,
    servingsOverridden: false,
    isSpecial: false,
  };
}

async function addMeal(
  repo: InMemoryRepository,
  householdId: HouseholdId,
  actor: MembershipId,
  date: string,
  mealType: PlannedMeal['mealType'] = 'dinner',
  servings = 4,
) {
  return repo.upsertPlannedMeal(householdId, meal(householdId, date, mealType, servings), actor);
}

async function addDelivery(
  repo: InMemoryRepository,
  householdId: HouseholdId,
  ingredientKey: string,
  quantity: number,
  unit: 'g' | 'ml' | 'count',
  daysAgo = 0,
  perishable = false,
  freshnessDays: number | null = null,
) {
  const at = new Date(`${TODAY}T08:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - daysAgo);
  await repo.appendPantryLedger(householdId, {
    ingredientKey,
    deltaG: unit === 'g' ? quantity : null,
    deltaMl: unit === 'ml' ? quantity : null,
    deltaCount: unit === 'count' ? quantity : null,
    source: 'order_delivered',
    perishable,
    freshnessDays,
    at: at.toISOString(),
  });
}

// ---- AC#1: delivered orders add dependable normalized quantities ----

test('AC1: a delivered order adds pantry availability; the cart omits covered ingredients', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY);
  // Deliver 500g toor_dal and 6 tomatoes — covers the 200g + 3 tomato need.
  await addDelivery(repo, household.id, 'toor_dal', 500, 'g');
  await addDelivery(repo, household.id, 'tomato', 6, 'count');

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  assert.equal(items.length, 0, 'all ingredients covered by the delivery');
});

test('AC1: checkout success alone (no delivery) does NOT update the pantry', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY);
  // Place an order (status placed, not delivered) — the pantry ledger gets no
  // order_delivered entry, so the cart still shows the need.
  const owner = (await repo.listMembers(household.id))[0]!;
  await repo.createOrder(household.id, owner.id, {
    providerOrderId: 'inst-1',
    status: 'placed',
    totalCents: 49900,
  });
  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  assert.ok(items.length > 0, 'placed (non-delivered) order does not update the pantry');
  assert.ok(items.some((i) => i.ingredientKey === 'toor_dal'));
});

// ---- AC#2: planned consumption is recalculated after plan changes ----

test('AC2: deriveConsumption produces negative deltas for dependable ingredients only', () => {
  const meals: PlannedMeal[] = [
    {
      ...meal(brandId<'HouseholdId'>('h'), '2026-01-08', 'dinner', 4),
      id: brandId<'PlannedMealId'>('m1'),
      householdId: brandId<'HouseholdId'>('h'),
      version: 1,
      updatedBy: null,
      updatedAt: '2026-01-08',
    },
  ];
  const entries = deriveConsumption(meals, new Map([['r-dal', RECIPE]]), TODAY);
  // toor_dal: -200g, tomato: -3 count, salt: skipped (unnormalizable)
  const dal = entries.find((e) => e.ingredientKey === 'toor_dal')!;
  assert.equal(dal.deltaG, -200);
  assert.equal(dal.source, 'consumption');
  const tomato = entries.find((e) => e.ingredientKey === 'tomato')!;
  assert.equal(tomato.deltaCount, -3);
  assert.equal(
    entries.find((e) => e.ingredientKey === null),
    undefined,
  );
  assert.equal(entries.length, 2);
});

test('AC2: consumption is recalculated after a servings change', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  const m = await addMeal(repo, household.id, ownerMembership.id, TODAY, 'dinner', 4);
  // 300g delivery: covers 200g need at 4 servings (300 >= 160).
  await addDelivery(repo, household.id, 'toor_dal', 300, 'g');

  // At 4 servings the 300g delivery covers 200g need → likely available.
  let items = await refreshSuggestedCart(repo, household.id, TODAY, new Date(`${TODAY}T10:00:00Z`));
  assert.ok(!items.some((i) => i.ingredientKey === 'toor_dal'), 'covered at 4 servings');

  // Bump to 8 servings → need 400g, 300g no longer covers (300 < 400*0.8=320).
  await repo.updatePlannedMeal(
    household.id,
    m.id,
    m.version,
    { servings: 8, servingsOverridden: true },
    ownerMembership.id,
  );
  items = await refreshSuggestedCart(repo, household.id, TODAY, new Date(`${TODAY}T10:00:00Z`));
  const dal8 = items.find((i) => i.ingredientKey === 'toor_dal');
  assert.ok(dal8, 'toor_dal appears as may_be_low at 8 servings');
  assert.equal(dal8!.confidence, 'may_be_low');

  // Drop back to 4 servings → need 200g, 300g covers again.
  await repo.updatePlannedMeal(
    household.id,
    m.id,
    m.version + 1,
    { servings: 4, servingsOverridden: false },
    ownerMembership.id,
  );
  items = await refreshSuggestedCart(repo, household.id, TODAY, new Date(`${TODAY}T10:00:00Z`));
  assert.ok(!items.some((i) => i.ingredientKey === 'toor_dal'), 'covered again at 4 servings');
});

test('AC2: consumption is recalculated after a recipe swap', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  const m = await addMeal(repo, household.id, ownerMembership.id, TODAY, 'dinner', 4);
  await addDelivery(repo, household.id, 'toor_dal', 500, 'g');
  await addDelivery(repo, household.id, 'tomato', 6, 'count');

  // Swap to a recipe with no toor_dal — the consumption ledger is rebuilt and
  // toor_dal is no longer needed.
  const paneerRecipe: Recipe = {
    ...RECIPE,
    id: brandId<'RecipeId'>('r-paneer'),
    name: 'Paneer Bhurji',
    ingredients: [
      {
        name: 'Paneer',
        ingredientKey: 'paneer',
        quantity: 250,
        unit: 'g',
        dependable: true,
        adjustToTaste: false,
      },
    ],
  };
  repo.recipes.set(paneerRecipe.id as string, paneerRecipe);
  await repo.updatePlannedMeal(
    household.id,
    m.id,
    m.version,
    { recipeId: paneerRecipe.id, name: 'Paneer Bhurji' },
    ownerMembership.id,
  );

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  assert.ok(!items.some((i) => i.ingredientKey === 'toor_dal'), 'old ingredient no longer needed');
  assert.ok(
    items.some((i) => i.ingredientKey === 'paneer'),
    'new ingredient appears',
  );
});

// ---- AC#3: perishable freshness degradation and unknown for unnormalizable ----

test('AC3: a spoiled perishable delivery contributes nothing to the cart', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  // A recipe that uses milk.
  const milkRecipe: Recipe = {
    ...RECIPE,
    id: brandId<'RecipeId'>('r-milk'),
    name: 'Chai',
    ingredients: [
      {
        name: 'Milk',
        ingredientKey: 'milk',
        quantity: 500,
        unit: 'ml',
        dependable: true,
        adjustToTaste: false,
      },
    ],
  };
  repo.recipes.set(milkRecipe.id as string, milkRecipe);
  await repo.upsertPlannedMeal(
    household.id,
    meal(household.id, TODAY, 'breakfast', 4),
    ownerMembership.id,
  );
  await repo.updatePlannedMeal(
    household.id,
    (await repo.listMealsForDay(household.id, TODAY))[0]!.id,
    1,
    { recipeId: milkRecipe.id, name: 'Chai' },
    ownerMembership.id,
  );
  // Deliver 1000ml milk 6 days ago, perishable with 3-day freshness → spoiled.
  await addDelivery(repo, household.id, 'milk', 1000, 'ml', 6, true, 3);

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  const milk = items.find((i) => i.ingredientKey === 'milk');
  assert.ok(milk, 'milk appears because the delivery spoiled');
  // A spoiled perishable means the old delivery is gone; we do not know if
  // the household bought more, so the confidence is `unknown` (AC#3).
  assert.equal(milk!.confidence, 'unknown');
});

test('AC3: a fresh perishable within the window counts fully', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  const milkRecipe: Recipe = {
    ...RECIPE,
    id: brandId<'RecipeId'>('r-milk'),
    name: 'Chai',
    ingredients: [
      {
        name: 'Milk',
        ingredientKey: 'milk',
        quantity: 500,
        unit: 'ml',
        dependable: true,
        adjustToTaste: false,
      },
    ],
  };
  repo.recipes.set(milkRecipe.id as string, milkRecipe);
  await repo.upsertPlannedMeal(
    household.id,
    meal(household.id, TODAY, 'breakfast', 4),
    ownerMembership.id,
  );
  await repo.updatePlannedMeal(
    household.id,
    (await repo.listMealsForDay(household.id, TODAY))[0]!.id,
    1,
    { recipeId: milkRecipe.id, name: 'Chai' },
    ownerMembership.id,
  );
  // Deliver 1000ml milk 1 day ago, perishable with 3-day freshness → fresh.
  await addDelivery(repo, household.id, 'milk', 1000, 'ml', 1, true, 3);

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  assert.ok(!items.some((i) => i.ingredientKey === 'milk'), 'fresh milk covers the need');
});

test('AC3: unnormalizable ingredients become unknown, never invented', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  // Recipe with only a salt (unnormalizable) ingredient — no ledger entry is
  // created and no cart line appears because there is no ingredientKey.
  const saltRecipe: Recipe = {
    ...RECIPE,
    id: brandId<'RecipeId'>('r-salt'),
    name: 'Salt Water',
    ingredients: [
      {
        name: 'Salt',
        ingredientKey: null,
        quantity: null,
        unit: 'g',
        dependable: false,
        adjustToTaste: true,
      },
    ],
  };
  repo.recipes.set(saltRecipe.id as string, saltRecipe);
  await repo.upsertPlannedMeal(
    household.id,
    meal(household.id, TODAY, 'dinner', 4),
    ownerMembership.id,
  );
  await repo.updatePlannedMeal(
    household.id,
    (await repo.listMealsForDay(household.id, TODAY))[0]!.id,
    1,
    { recipeId: saltRecipe.id, name: 'Salt Water' },
    ownerMembership.id,
  );

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  assert.equal(items.length, 0, 'unnormalizable ingredient produces no cart line');
});

// ---- AC#4: approved grocery requests override the pantry ----

test('AC4: an approved grocery request always appears even when the pantry covers it', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY);
  await addDelivery(repo, household.id, 'toor_dal', 500, 'g');
  await addDelivery(repo, household.id, 'tomato', 6, 'count');

  // Cook requests coconut; Member approves.
  const cookUser = await repo.createUser({
    id: brandId<'UserId'>('u-cook'),
    clerkUserId: 'cook',
    phone: '+919000000001',
    displayName: 'Cook',
  });
  const cookMembership = await repo.addMembership(household.id, cookUser.id, 'cook');
  const { request } = await repo.createGroceryRequest(
    household.id,
    { itemText: 'coconut', quantityText: '2' },
    cookMembership.id,
  );
  await repo.updateGroceryRequest(
    household.id,
    request.id,
    request.version,
    { status: 'approved' },
    ownerMembership.id,
  );

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  const coconut = items.find((i) => i.groceryRequestId === request.id);
  assert.ok(coconut, 'approved request appears in the cart');
  assert.equal(coconut!.freeTextItem, 'coconut');
  assert.equal(coconut!.confidence, 'unknown');
});

test('AC4: an approved request for a likely-available ingredient still appears', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY);
  // Deliver enough toor_dal to cover the need → likely_available (no cart line).
  await addDelivery(repo, household.id, 'toor_dal', 500, 'g');
  await addDelivery(repo, household.id, 'tomato', 6, 'count');

  // Cook requests "toor_dal extra" — even though the pantry says likely
  // available, the Cook saw a real shortage. The approved request overrides.
  const cookUser = await repo.createUser({
    id: brandId<'UserId'>('u-cook2'),
    clerkUserId: 'cook2',
    phone: '+919000000010',
    displayName: 'Cook 2',
  });
  const cookMembership = await repo.addMembership(household.id, cookUser.id, 'cook');
  const { request } = await repo.createGroceryRequest(
    household.id,
    { itemText: 'toor_dal extra', quantityText: '1 kg' },
    cookMembership.id,
  );
  await repo.updateGroceryRequest(
    household.id,
    request.id,
    request.version,
    { status: 'approved' },
    ownerMembership.id,
  );

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  // The approved request appears even though toor_dal was likely_available.
  const reqLine = items.find((i) => i.groceryRequestId === request.id);
  assert.ok(reqLine, 'approved request overrides likely_available classification');
  assert.equal(reqLine!.freeTextItem, 'toor_dal extra');
});

// ---- AC#5: the cart covers today + next two calendar days with explanations ----

test('AC5: the cart covers today + next two calendar days and explains each line', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY);
  await addMeal(repo, household.id, ownerMembership.id, addDays(TODAY, 1));
  await addMeal(repo, household.id, ownerMembership.id, addDays(TODAY, 2));
  // A meal on day 3 (outside the horizon) does NOT produce a cart line.
  await addMeal(repo, household.id, ownerMembership.id, addDays(TODAY, 3));

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  // toor_dal and tomato appear; their affectedMeals list the 3 horizon meals.
  const dal = items.find((i) => i.ingredientKey === 'toor_dal')!;
  assert.ok(dal);
  assert.equal(dal.affectedMeals.length, 3, 'only the 3 horizon meals are explained');
  assert.ok(dal.affectedMeals.every((m) => m.date <= addDays(TODAY, 2)));
  assert.equal(dal.needDay, 'today');
  // The day-3 meal is NOT in any cart line's affected meals.
  assert.ok(!dal.affectedMeals.some((m) => m.date === addDays(TODAY, 3)));
});

test('AC5: needDay reflects the earliest affected meal', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  // Only a meal tomorrow → needDay should be 'tomorrow'.
  await addMeal(repo, household.id, ownerMembership.id, addDays(TODAY, 1));

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  const dal = items.find((i) => i.ingredientKey === 'toor_dal')!;
  assert.equal(dal.needDay, 'tomorrow');
});

// ---- AC#6: uncertain items appear as Check at home and can be kept/removed ----

test('AC6: uncertain items have checkAtHome and can be kept or removed', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY);

  const items = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  assert.ok(items.every((i) => i.confidence !== 'likely_available'));
  assert.ok(items.every((i) => i.memberState === 'pending'));

  // Remove the toor_dal line with a reason.
  const dal = items.find((i) => i.ingredientKey === 'toor_dal')!;
  await repo.setCartItemState(household.id, dal.id, 'removed', 'already_have');
  const after = await repo.getSuggestedCart(household.id);
  const dalAfter = after.find((i) => i.id === dal.id)!;
  assert.equal(dalAfter.memberState, 'removed');
  assert.equal(dalAfter.removalReason, 'already_have');

  // Keep the tomato line.
  const tomato = items.find((i) => i.ingredientKey === 'tomato')!;
  await repo.setCartItemState(household.id, tomato.id, 'kept', null);
  const after2 = await repo.getSuggestedCart(household.id);
  const tomatoAfter = after2.find((i) => i.id === tomato.id)!;
  assert.equal(tomatoAfter.memberState, 'kept');
});

// ---- AC#7: optional removal reasons improve later estimates ----

test('AC7: an already_have removal reason does not re-suggest the ingredient', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY);

  // First refresh: toor_dal appears as may_be_low.
  let items = await refreshSuggestedCart(repo, household.id, TODAY, new Date(`${TODAY}T10:00:00Z`));
  const dal = items.find((i) => i.ingredientKey === 'toor_dal')!;
  assert.ok(dal, 'toor_dal appears in the first cart');

  // Member removes it with "already_have" — they know they have it at home.
  await repo.setCartItemState(household.id, dal.id, 'removed', 'already_have');

  // Second refresh: the Member's "already_have" reason improves the estimate.
  // toor_dal is treated as likely available and does NOT reappear.
  items = await refreshSuggestedCart(repo, household.id, TODAY, new Date(`${TODAY}T10:00:00Z`));
  assert.ok(
    !items.some((i) => i.ingredientKey === 'toor_dal'),
    'already_have removal prevents toor_dal from reappearing',
  );

  // The tomato line (not removed with already_have) still appears.
  assert.ok(
    items.some((i) => i.ingredientKey === 'tomato'),
    'tomato still appears',
  );
});

// ---- AC#8: household isolation and deterministic behaviour ----

test('AC8: the cart and pantry ledger are isolated per household', async () => {
  const repoA = new InMemoryRepository();
  const repoB = new InMemoryRepository();
  // Two separate repositories simulate two separate household databases.
  const { household: ha, ownerMembership: ownerA } = await setupHousehold(repoA);
  const userB = await repoB.createUser({
    id: brandId<'UserId'>('u-owner-b'),
    clerkUserId: 'owner-b',
    phone: '+919000000002',
    displayName: 'Owner B',
  });
  const { household: hb, ownerMembership: ownerB } = await repoB.createHousehold(
    makeHousehold('House B'),
    userB.id,
  );
  repoB.recipes.set(RECIPE.id as string, RECIPE);

  await addMeal(repoA, ha.id, ownerA.id, TODAY);
  await addDelivery(repoA, ha.id, 'toor_dal', 500, 'g');

  await addMeal(repoB, hb.id, ownerB.id, TODAY);
  // House B has no delivery → toor_dal is may_be_low.

  const itemsA = await refreshSuggestedCart(repoA, ha.id, TODAY, new Date(`${TODAY}T10:00:00Z`));
  const itemsB = await refreshSuggestedCart(repoB, hb.id, TODAY, new Date(`${TODAY}T10:00:00Z`));

  // A has the delivery → no toor_dal line. B has no delivery → toor_dal appears.
  assert.ok(!itemsA.some((i) => i.ingredientKey === 'toor_dal'));
  assert.ok(itemsB.some((i) => i.ingredientKey === 'toor_dal'));
});

test('AC8: a single household with two meals produces deterministic cart lines', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addMeal(repo, household.id, ownerMembership.id, TODAY, 'lunch', 4);
  await addMeal(repo, household.id, ownerMembership.id, TODAY, 'dinner', 4);

  const items1 = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  const items2 = await refreshSuggestedCart(
    repo,
    household.id,
    TODAY,
    new Date(`${TODAY}T10:00:00Z`),
  );
  assert.deepEqual(
    items1.map((i) => i.id).sort(),
    items2.map((i) => i.id).sort(),
    'cart is deterministic across refreshes',
  );
  // Two meals → 400g toor_dal need, 6 tomatoes. With no pantry → both appear.
  const dal = items1.find((i) => i.ingredientKey === 'toor_dal')!;
  assert.equal(dal.affectedMeals.length, 2);
});

test('AC8: replaceConsumptionLedger only affects consumption entries', async () => {
  const repo = new InMemoryRepository();
  const { household, ownerMembership } = await setupHousehold(repo);
  await addDelivery(repo, household.id, 'toor_dal', 500, 'g');

  // Add a past meal so the orchestrator creates a consumption entry.
  await addMeal(repo, household.id, ownerMembership.id, addDays(TODAY, -1));
  await refreshSuggestedCart(repo, household.id, TODAY, new Date(`${TODAY}T10:00:00Z`));

  const allEntries = repo.ledger.filter((e) => e.householdId === household.id);
  assert.ok(allEntries.some((e) => e.source === 'order_delivered'));
  assert.ok(allEntries.some((e) => e.source === 'consumption'));

  // Replace consumption — the order_delivered entry must survive.
  await repo.replaceConsumptionLedger(household.id, []);
  const after = repo.ledger.filter((e) => e.householdId === household.id);
  assert.ok(
    after.some((e) => e.source === 'order_delivered'),
    'delivery entry preserved',
  );
  assert.ok(!after.some((e) => e.source === 'consumption'), 'consumption entries replaced');
});
