import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStarterPlan, swapMealIdentities, regenerateKeepsEdited } from '../meal-plan.js';

const TODAY = '2026-01-10';

test('regeneration excludes the previous slot even when randomness repeats', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const seed = {
    dietStyle: 'vegetarian' as const,
    mealStyle: 'north' as const,
    servings: 4,
    specialMealEnabled: true,
  };
  const previous = generateStarterPlan(TODAY, seed);
  const regenerated = generateStarterPlan(TODAY, seed, previous);
  for (const [index, meal] of regenerated.entries()) {
    assert.notEqual(meal.name, previous[index]!.name);
    assert.equal(meal.date, previous[index]!.date);
    assert.equal(meal.mealType, previous[index]!.mealType);
  }
});

test('starter plan produces 7 days x 3 meals with no approval step', () => {
  const plan = generateStarterPlan(TODAY, {
    dietStyle: 'vegetarian',
    mealStyle: 'north',
    servings: 4,
    specialMealEnabled: false,
  });
  assert.equal(plan.length, 21);
  const days = new Set(plan.map((m) => m.date));
  assert.equal(days.size, 7);
});

test('a special meal appears roughly once per week when enabled', () => {
  const plan = generateStarterPlan(TODAY, {
    dietStyle: 'vegetarian',
    mealStyle: 'north',
    servings: 4,
    specialMealEnabled: true,
  });
  assert.equal(plan.filter((m) => m.isSpecial).length, 1);
});

test('no special meal when disabled', () => {
  const plan = generateStarterPlan(TODAY, {
    dietStyle: 'vegetarian',
    mealStyle: 'south',
    servings: 4,
    specialMealEnabled: false,
  });
  assert.equal(plan.filter((m) => m.isSpecial).length, 0);
});

test('swap exchanges identities but preserves slot/servings', () => {
  const a = makeMeal('Dal', true);
  const b = makeMeal('Paneer', false);
  const swap = swapMealIdentities(a, b);
  assert.equal(swap.a.name, 'Paneer');
  assert.equal(swap.b.name, 'Dal');
  // servings/day/mealType are not part of the identity patch
  assert.equal('servings' in swap.a, false);
});

test('regenerate never touches the past and keeps edited meals by default', () => {
  const pastMeal = { date: '2026-01-09' };
  const futureEdited = { date: '2026-01-12' };
  const futurePlain = { date: '2026-01-12' };
  const scope = { kind: 'remaining_week' as const, fromDate: '2026-01-11' };
  assert.equal(regenerateKeepsEdited(pastMeal, scope, TODAY, false), true);
  assert.equal(regenerateKeepsEdited(futureEdited, scope, TODAY, true), true);
  assert.equal(regenerateKeepsEdited(futurePlain, scope, TODAY, false), false);
});

function makeMeal(name: string, isSpecial: boolean) {
  return {
    id: 'm' as never,
    householdId: 'h' as never,
    date: TODAY,
    mealType: 'dinner' as const,
    recipeId: null,
    name,
    servings: 4,
    servingsOverridden: false,
    isSpecial,
    version: 1,
    updatedBy: null,
    updatedAt: TODAY,
  };
}
