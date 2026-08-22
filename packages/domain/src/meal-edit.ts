import type { MembershipId, PlannedMealId, RecipeId } from './ids.js';
import type { DietStyle, ISODate, MealStyle, PlannedMeal, Recipe } from './domain-types.js';
import { generateStarterPlan, type RegenerateScope } from './meal-plan.js';

/**
 * The action layer for editing an active Weekly Meal Plan from either role
 * (ticket 05). The pure rules that the server applies before any write:
 *
 * - optimistic concurrency: a stale edit cannot overwrite a newer version
 *   (issue 04/06, ticket 05 — show the current meal, require fresh confirmation);
 * - past meals are immutable: edits and regeneration never rewrite completed
 *   meals (issue 04 — Regenerate never changes the past);
 * - a servings override is flagged and clamped, and persists only on its slot;
 * - regeneration keeps manually edited meals by default unless the person
 *   explicitly includes them (issue 04 — Regenerate keeps edited meals).
 *
 * Nothing here authorizes a purchase; grocery consequences remain suggestions
 * handled by Estimated Pantry and the Suggested Grocery Cart.
 */

/** The supported Serving Count range (issue 04 — Serving Count). */
export const MIN_SERVINGS = 1;
export const MAX_SERVINGS = 12;
export const DEFAULT_SERVINGS = 4;

/** Clamp a per-meal Serving Count override to the supported range. */
export function clampServings(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return DEFAULT_SERVINGS;
  }
  const rounded = Math.round(value);
  return Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, rounded));
}

export interface MealEditRequest {
  mealId: PlannedMealId;
  /** The version the caller saw (optimistic concurrency, issue 04/06). */
  expectedVersion: number;
  patch: MealPatch;
}

/**
 * A meal patch as submitted by the client. `servings` and `isSpecial` are
 * optional; omitting them leaves the slot untouched rather than resetting it.
 */
export interface MealPatch {
  recipeId?: string | null;
  name?: string;
  servings?: number;
  isSpecial?: boolean;
}

type MealEditDecision =
  | {
      ok: true;
      /** The materialized patch to persist, with version/actor applied. */
      result: PlannedMeal;
    }
  | {
      ok: false;
      reason: 'stale_version' | 'past_meal';
      /** The current meal, so the client can re-render and ask for a fresh tap. */
      current: PlannedMeal;
    };

/**
 * Resolve a meal edit against optimistic concurrency and the past-meal guard.
 * The server MUST call this before writing; the returned `result` is the full
 * next row (version bumped, attributed to the actor).
 *
 * Note: this does not re-authorize membership — the caller has already resolved
 * a principal and verified the `edit_meal_plan` capability. It only owns the
 * concurrency and immutability rules.
 */
export function decideMealEdit(input: {
  current: PlannedMeal;
  request: MealEditRequest;
  actor: MembershipId;
  now: ISODate;
}): MealEditDecision {
  const { current, request, actor, now } = input;
  if (current.date < now) {
    return { ok: false, reason: 'past_meal', current };
  }
  if (current.version !== request.expectedVersion) {
    return { ok: false, reason: 'stale_version', current };
  }
  const materialized: PlannedMeal = {
    ...current,
    ...editPatchFor(request.patch),
    version: current.version + 1,
    updatedBy: actor,
    updatedAt: now,
  };
  return { ok: true, result: materialized };
}

/**
 * Materialize a client patch into the fields that are persisted on the slot.
 *
 * A typed name replacement (issue 04 — Search/replace or free text) is treated
 * as a fresh identity for the slot: the recipe link is cleared unless the caller
 * explicitly supplies one, and the special flag is reset unless explicitly set.
 * A servings value flips `servingsOverridden` and is clamped; omitting servings
 * leaves the slot's servings untouched (no key emitted).
 */
export function editPatchFor(patch: MealPatch): Partial<PlannedMeal> {
  const out: Partial<PlannedMeal> = {};
  const named = patch.name !== undefined;
  if (patch.recipeId !== undefined) {
    out.recipeId = patch.recipeId ? (patch.recipeId as RecipeId) : null;
  } else if (named) {
    out.recipeId = null;
  }
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.isSpecial !== undefined) {
    out.isSpecial = patch.isSpecial;
  } else if (named) {
    out.isSpecial = false;
  }
  if (patch.servings !== undefined) {
    out.servings = clampServings(patch.servings);
    out.servingsOverridden = true;
  }
  return out;
}

export interface RegeneratePlan {
  kind: RegenerateScope['kind'];
  /** The slot ids + draft meals that regeneration should replace. */
  replace: { mealId: PlannedMealId; draft: RegenerateDraft }[];
}

/** A draft produced by regeneration; the server applies it via optimistic update. */
export interface RegenerateDraft {
  recipeId: string | null;
  name: string;
  isSpecial: boolean;
  servings: number;
}

/**
 * Resolve which slots a regeneration request should replace, honouring:
 * - never the past (issue 04 — Regenerate never changes completed meals);
 * - manually edited meals are kept by default, included only on an explicit
 *   opt-in (issue 04 — "include edited meals" is an explicit option);
 * - `meal` replaces exactly one slot; `day` replaces a calendar day; the
 *   remaining-week scope replaces everything from `fromDate` forward.
 *
 * The drafts are drawn from the deterministic starter library so the server can
 * apply them transactionally; the production planner layers AI + Household
 * history on top of these same constraints.
 */
export function planRegeneration(
  plan: PlannedMeal[],
  input: {
    kind: RegenerateScope['kind'];
    /** For `meal` scope: the slot to regenerate. */
    target?: PlannedMeal;
    /** For `day` and `remaining_week`: the anchor calendar date. */
    fromDate?: ISODate;
    includeEdited: boolean;
    today: ISODate;
    seed?: {
      dietStyle: DietStyle;
      mealStyle: MealStyle;
      servings: number;
      specialMealEnabled: boolean;
    };
  },
): RegeneratePlan {
  const drafts = new Map<string, RegenerateDraft>();
  if (input.seed) {
    for (const draft of generateStarterPlan(input.today, input.seed)) {
      drafts.set(`${draft.date}|${draft.mealType}`, {
        recipeId: draft.recipeId,
        name: draft.name,
        isSpecial: draft.isSpecial,
        servings: draft.servings,
      });
    }
  }

  const shouldKeep = (meal: PlannedMeal): boolean => {
    if (meal.date < input.today) return true;
    if (!input.includeEdited && meal.servingsOverridden) return true;
    if (!input.includeEdited && meal.updatedBy !== null) return true;
    return false;
  };

  const replace: RegeneratePlan['replace'] = [];
  for (const meal of plan) {
    let inScope = false;
    if (input.kind === 'meal' && input.target) {
      inScope = meal.id === input.target.id && meal.date >= input.today;
    } else if (input.kind === 'day' && input.fromDate) {
      inScope = meal.date === input.fromDate && meal.date >= input.today;
    } else if (input.kind === 'remaining_week' && input.fromDate) {
      inScope = meal.date >= input.fromDate && meal.date >= input.today;
    }
    if (!inScope) continue;
    if (shouldKeep(meal)) continue;
    const draft = drafts.get(`${meal.date}|${meal.mealType}`) ?? {
      recipeId: meal.recipeId,
      name: meal.name,
      isSpecial: meal.isSpecial,
      servings: meal.servings,
    };
    replace.push({ mealId: meal.id, draft });
  }
  return { kind: input.kind, replace };
}

export interface RankedCandidate {
  recipe: Recipe;
  /** True when the recipe is outside the Household's active diet (issue 04). */
  dietMismatch: boolean;
}

/**
 * Rank search candidates for a manual meal replacement (issue 04 — Search).
 *
 * - matches case-insensitively against the English or Hindi name;
 * - in-diet recipes rank before out-of-diet matches;
 * - out-of-diet matches are still surfaced, flagged, so the member confirms the
 *   mismatch rather than silently picking a profile-violating meal;
 * - meal-type compatibility is a tie-breaker, not a hard filter, so a person may
 *   intentionally place a dinner recipe at lunch.
 *
 * Search text is never shared as Chat content; only the resulting confirmed
 * change produces a system event (issue 04 — Search).
 */
export function rankSearchCandidates(
  query: string,
  candidates: Recipe[],
  householdDietStyle: DietStyle,
): RankedCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matched = candidates.filter((recipe) => {
    const en = recipe.name.toLowerCase();
    const hi = recipe.nameHi?.toLowerCase() ?? '';
    return en.includes(q) || hi.includes(q);
  });
  const ranked = matched
    .map((recipe) => ({
      recipe,
      dietMismatch: isMorePermissive(recipe.dietStyle, householdDietStyle),
    }))
    .sort((a, b) => {
      // in-diet first, then stable by name so results are deterministic.
      if (a.dietMismatch !== b.dietMismatch) return a.dietMismatch ? 1 : -1;
      return a.recipe.name.localeCompare(b.recipe.name);
    });
  return ranked;
}

const DIET_ORDER: readonly DietStyle[] = ['vegetarian', 'eggetarian', 'nonvegetarian'];

/**
 * True when `style` permits something `limit` forbids, i.e. adding it would
 * violate the Household's most-restrictive active diet. Vegetarian is the most
 * restrictive; non-vegetarian is the most permissive.
 */
function isMorePermissive(style: DietStyle, limit: DietStyle): boolean {
  return DIET_ORDER.indexOf(style) > DIET_ORDER.indexOf(limit);
}
