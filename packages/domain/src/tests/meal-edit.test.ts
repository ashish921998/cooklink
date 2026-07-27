import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampServings,
  decideMealEdit,
  editPatchFor,
  planRegeneration,
  rankSearchCandidates,
  type MealEditRequest,
} from '../meal-edit.js';
import { id } from '../ids.js';
import type { MembershipId } from '../ids.js';
import type { DietStyle, PlannedMeal, Recipe } from '../types.js';

const TODAY = '2026-01-10';
const ACTOR = 'm-1' as MembershipId;

function makeMeal(
  overrides: Partial<PlannedMeal> & { date: string; mealType: PlannedMeal['mealType'] },
): PlannedMeal {
  return {
    id: id<'PlannedMealId'>('m-' + overrides.date + overrides.mealType),
    householdId: 'h' as never,
    recipeId: null,
    name: 'Plain Meal',
    servings: 4,
    servingsOverridden: false,
    isSpecial: false,
    version: 1,
    updatedBy: null,
    updatedAt: overrides.date,
    ...overrides,
  };
}

// ---- optimistic concurrency (issue 04/06, ticket 05 — stale edit recovery) ----

test('a fresh edit on the current version is accepted and bumps the version', () => {
  const current = makeMeal({ date: TODAY, mealType: 'dinner', version: 3, name: 'Dal' });
  const request: MealEditRequest = {
    mealId: current.id,
    expectedVersion: 3,
    patch: { name: 'Paneer' },
  };
  const decision = decideMealEdit({ current, request, actor: ACTOR, now: TODAY });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.result.name, 'Paneer');
  assert.equal(decision.result.version, 4);
  assert.equal(decision.result.updatedBy, ACTOR);
});

test('a stale edit is rejected with the current meal for fresh confirmation', () => {
  const current = makeMeal({ date: TODAY, mealType: 'dinner', version: 5, name: 'Paneer' });
  const request: MealEditRequest = {
    mealId: current.id,
    expectedVersion: 3,
    patch: { name: 'Rajma' },
  };
  const decision = decideMealEdit({ current, request, actor: ACTOR, now: TODAY });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.reason, 'stale_version');
  assert.equal(decision.current.name, 'Paneer');
});

// ---- past meals are immutable (issue 04 — regenerate never touches the past) ----

test('an edit to a past meal is rejected as out of range', () => {
  const past = makeMeal({ date: '2026-01-09', mealType: 'dinner', version: 1 });
  const request: MealEditRequest = {
    mealId: past.id,
    expectedVersion: 1,
    patch: { name: 'X' },
  };
  const decision = decideMealEdit({ current: past, request, actor: ACTOR, now: TODAY });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.reason, 'past_meal');
});

// ---- servings clamp (issue 04 — Serving Count override) ----

test('clampServings keeps servings within the supported range', () => {
  assert.equal(clampServings(0), 1);
  assert.equal(clampServings(1), 1);
  assert.equal(clampServings(4), 4);
  assert.equal(clampServings(12), 12);
  assert.equal(clampServings(13), 12);
  assert.equal(clampServings(NaN), 4);
  assert.equal(clampServings(undefined), 4);
  assert.equal(clampServings(3.7), 4);
});

// ---- a servings override is flagged and persisted on the slot ----

test('an edit with servings flips servingsOverridden and keeps the meal type/date', () => {
  const patch = editPatchFor({ name: 'Chole', servings: 6 });
  assert.deepEqual(patch, {
    recipeId: null,
    name: 'Chole',
    servings: 6,
    servingsOverridden: true,
    isSpecial: false,
  });
});

test('an edit that omits servings leaves the slot untouched and not flagged', () => {
  const patch = editPatchFor({ name: 'Chole' });
  // servings / servingsOverridden are simply absent: the slot keeps its values.
  assert.equal('servings' in patch, false);
  assert.equal('servingsOverridden' in patch, false);
});

// ---- regenerate planner (issue 04 — never rewrite past, keep edited by default) ----

test('regenerate one meal touches only that future slot', () => {
  const plan = [
    makeMeal({ date: '2026-01-09', mealType: 'dinner', name: 'Past' }),
    makeMeal({ date: TODAY, mealType: 'breakfast', name: 'Keep' }),
    makeMeal({ date: TODAY, mealType: 'lunch', name: 'Replace Me' }),
    makeMeal({ date: '2026-01-11', mealType: 'dinner', name: 'Future' }),
  ];
  const target = plan[2]!;
  const result = planRegeneration(plan, {
    kind: 'meal',
    target,
    includeEdited: false,
    today: TODAY,
  });
  assert.equal(result.replace.length, 1);
  assert.equal(result.replace[0]!.mealId, target.id);
});

test('regenerate a day replaces every meal in that future day but not edited ones unless included', () => {
  const plan = [
    makeMeal({ date: TODAY, mealType: 'breakfast', name: 'B', servingsOverridden: true }),
    makeMeal({ date: TODAY, mealType: 'lunch', name: 'L' }),
    makeMeal({ date: TODAY, mealType: 'dinner', name: 'D' }),
    makeMeal({ date: '2026-01-11', mealType: 'dinner', name: 'NextDay' }),
  ];
  const keepEdited = planRegeneration(plan, {
    kind: 'day',
    fromDate: TODAY,
    includeEdited: false,
    today: TODAY,
  });
  assert.equal(
    keepEdited.replace.some((r) => plan[0]!.name === 'B' && r.mealId === plan[0]!.id),
    false,
  );
  assert.equal(keepEdited.replace.length, 2); // lunch + dinner only

  const includeEdited = planRegeneration(plan, {
    kind: 'day',
    fromDate: TODAY,
    includeEdited: true,
    today: TODAY,
  });
  assert.equal(includeEdited.replace.length, 3);
});

test('regenerate remaining week never includes past or before-fromDate meals', () => {
  const plan = [
    makeMeal({ date: '2026-01-09', mealType: 'dinner', name: 'Past' }),
    makeMeal({ date: TODAY, mealType: 'breakfast', name: 'TodayB' }),
    makeMeal({ date: '2026-01-12', mealType: 'lunch', name: 'Future1' }),
    makeMeal({ date: '2026-01-14', mealType: 'dinner', name: 'Future2' }),
  ];
  const result = planRegeneration(plan, {
    kind: 'remaining_week',
    fromDate: '2026-01-11',
    includeEdited: true,
    today: TODAY,
  });
  assert.equal(result.replace.length, 2);
  assert.ok(result.replace.every((r) => r.mealId !== plan[0]!.id));
  assert.ok(result.replace.every((r) => r.mealId !== plan[1]!.id));
});

// ---- search ranking (issue 04 — search returns allowed-by-profile first) ----

function makeRecipe(
  name: string,
  dietStyle: DietStyle,
  mealTypes: Recipe['mealTypes'],
  nameHi: string | null = null,
): Recipe {
  return {
    id: ('r-' + name) as never,
    name,
    nameHi,
    baseServings: 4,
    ingredients: [],
    steps: [],
    stepsHi: null,
    provenance: 'verified',
    dietStyle,
    mealStyle: 'north',
    mealTypes,
  };
}

test('rankSearchCandidates puts in-diet recipes first and warns on out-of-diet matches', () => {
  const candidates = [
    makeRecipe('Chicken Curry', 'nonvegetarian', ['lunch', 'dinner']),
    makeRecipe('Vegetable Curry', 'vegetarian', ['lunch', 'dinner']),
    makeRecipe('Egg Curry', 'eggetarian', ['lunch', 'dinner']),
  ];
  const ranked = rankSearchCandidates('curry', candidates, 'vegetarian');
  // vegetarian-safe match ranks first; the out-of-diet matches are still
  // surfaced but flagged so the member confirms the mismatch (issue 04 — Search).
  assert.equal(ranked[0]!.recipe.name, 'Vegetable Curry');
  assert.equal(ranked[0]!.dietMismatch, false);
  assert.equal(ranked.find((r) => r.recipe.name === 'Chicken Curry')!.dietMismatch, true);
});

test('rankSearchCandidates matches case-insensitively and on Hindi name', () => {
  const candidates = [makeRecipe('Dal', 'vegetarian', ['lunch'], 'दाल')];
  const byHi = rankSearchCandidates('दाल', candidates, 'vegetarian');
  assert.equal(byHi.length, 1);
  const byEn = rankSearchCandidates('dal', candidates, 'vegetarian');
  assert.equal(byEn.length, 1);
});

test('rankSearchCandidates is empty for a query that matches nothing', () => {
  const ranked = rankSearchCandidates(
    'xyz',
    [makeRecipe('Dal', 'vegetarian', ['lunch'])],
    'vegetarian',
  );
  assert.equal(ranked.length, 0);
});
