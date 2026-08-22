import type { Recipe, RecipeIngredient } from './domain-types.js';

/**
 * Scales a recipe's dependable ingredient quantities deterministically from
 * its {@link Recipe.baseServings} to the planned servings (issue 08: recipe
 * scaling and accuracy).
 *
 * Dependable ingredients scale by `servings / baseServings`. Salt, oil,
 * spices, water, and judgement-based ingredients (`adjustToTaste`) keep their
 * range/"adjust to taste" guidance and are NOT given false precision — and
 * they never feed Estimated Pantry math.
 */
export function scaleIngredient(
  ing: RecipeIngredient,
  servings: number,
  baseServings: number,
): {
  name: string;
  quantity: number | null;
  unit: RecipeIngredient['unit'];
  dependable: boolean;
  display: string;
} {
  if (ing.adjustToTaste || ing.quantity == null || !ing.dependable) {
    return {
      name: ing.name,
      quantity: null,
      unit: ing.unit,
      dependable: false,
      display: ing.adjustToTaste ? `${ing.name} — adjust to taste` : ing.name,
    };
  }
  const factor = servings / baseServings;
  const scaled = roundQuantity(ing.quantity * factor);
  return {
    name: ing.name,
    quantity: scaled,
    unit: ing.unit,
    dependable: true,
    display: `${ing.name} — ${scaled}${unitSuffix(ing.unit)}`,
  };
}

export function scaleRecipe(recipe: Recipe, servings: number) {
  return {
    ...recipe,
    scaledIngredients: recipe.ingredients.map((i) =>
      scaleIngredient(i, servings, recipe.baseServings),
    ),
  };
}

function roundQuantity(n: number): number {
  // Round to 2 decimals; avoid float noise in display.
  return Math.round(n * 100) / 100;
}

function unitSuffix(unit: RecipeIngredient['unit']): string {
  switch (unit) {
    case 'g':
      return 'g';
    case 'ml':
      return 'ml';
    case 'count':
      return '';
    default:
      return '';
  }
}

/** Only dependable, normalizable ingredients feed Estimated Pantry (issue 05). */
export function dependableIngredients(recipe: Recipe): RecipeIngredient[] {
  return recipe.ingredients.filter((i) => i.dependable && i.quantity != null && i.ingredientKey);
}
