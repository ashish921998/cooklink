import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestedCart, needDayFor } from '../cart.js';
import type { PlannedMeal, Recipe, PantryLedgerEntry, GroceryRequest } from '../domain-types.js';

const TODAY = '2026-01-10';
const recipe: Recipe = {
  id: 'r1' as never,
  name: 'Dal Tadka',
  nameHi: null,
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
};
const meal = (date: string): PlannedMeal => ({
  id: 'm' as never,
  householdId: 'h' as never,
  date,
  mealType: 'dinner',
  recipeId: 'r1' as never,
  name: 'Dal Tadka',
  servings: 4,
  servingsOverridden: false,
  isSpecial: false,
  version: 1,
  updatedBy: null,
  updatedAt: date,
});

test('empty pantry → needed ingredients appear as may be low / unknown', () => {
  const drafts = buildSuggestedCart({
    today: TODAY,
    meals: [meal(TODAY)],
    recipesById: new Map([['r1', recipe]]),
    pantryByIngredient: new Map(),
    approvedRequests: [],
  });
  const keys = drafts.map((d) => d.ingredientKey).sort();
  assert.deepEqual(keys, ['tomato', 'toor_dal']);
  assert.ok(drafts.every((d) => d.checkAtHome));
  assert.equal(drafts[0]!.needDay, 'today');
});

test('likely-available ingredients are omitted (covered at home)', () => {
  const pantry = new Map<string, PantryLedgerEntry[]>([
    ['toor_dal', [pantryEntry('toor_dal', 500, null, null)]],
    ['tomato', [pantryEntry('tomato', null, null, 6)]],
  ]);
  const drafts = buildSuggestedCart({
    today: TODAY,
    meals: [meal(TODAY)],
    recipesById: new Map([['r1', recipe]]),
    pantryByIngredient: pantry,
    approvedRequests: [],
  });
  assert.equal(drafts.length, 0); // all covered
});

test('approved grocery requests always override the pantry', () => {
  const pantry = new Map<string, PantryLedgerEntry[]>([
    ['toor_dal', [pantryEntry('toor_dal', 500, null, null)]],
    ['tomato', [pantryEntry('tomato', null, null, 6)]],
  ]);
  const req: GroceryRequest = {
    id: 'gr1' as never,
    householdId: 'h' as never,
    itemText: 'coconut',
    quantityText: '2',
    status: 'approved',
    createdById: 'c' as never,
    createdAt: TODAY,
    resolvedById: null,
    resolvedAt: null,
    version: 1,
  };
  const drafts = buildSuggestedCart({
    today: TODAY,
    meals: [meal(TODAY)],
    recipesById: new Map([['r1', recipe]]),
    pantryByIngredient: pantry,
    approvedRequests: [req],
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.groceryRequestId, 'gr1' as never);
  assert.equal(drafts[0]!.checkAtHome, true);
});

test('needDayFor maps only today + next two calendar days', () => {
  assert.equal(needDayFor(TODAY, TODAY), 'today');
  assert.equal(needDayFor(TODAY, '2026-01-11'), 'tomorrow');
  assert.equal(needDayFor(TODAY, '2026-01-12'), 'day_after');
  assert.equal(needDayFor(TODAY, '2026-01-13'), null);
  assert.equal(needDayFor(TODAY, '2026-01-09'), null);
});

function pantryEntry(
  ingredientKey: string,
  g: number | null,
  ml: number | null,
  count: number | null,
): PantryLedgerEntry {
  return {
    id: 'l',
    householdId: 'h' as never,
    ingredientKey,
    deltaG: g,
    deltaMl: ml,
    deltaCount: count,
    source: 'order_delivered',
    perishable: false,
    freshnessDays: null,
    at: TODAY,
  };
}
