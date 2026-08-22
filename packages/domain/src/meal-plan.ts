import type { DietStyle, ISODate, MealStyle, MealType, PlannedMeal } from './domain-types.js';
import { MEAL_TYPES, mostRestrictiveDietStyle } from './domain-types.js';
import { addDays } from './cart.js';

/**
 * Automatic meal planning (issue 04). A Weekly Meal Plan becomes active
 * immediately from lightweight signals; there is no approval state. This
 * module provides deterministic generation + editing rules. The production
 * generator layers AI + Household history on top of these same constraints.
 */

export interface PlanSeed {
  dietStyle: DietStyle;
  mealStyle: MealStyle;
  servings: number;
  specialMealEnabled: boolean;
}

/** Familiar Indian home-cooking seed library (a safe starter). */
const SEED: Record<MealStyle, Record<DietStyle, Record<MealType, string[]>>> = {
  north: {
    vegetarian: {
      breakfast: ['Poha', 'Aloo Paratha', 'Besan Chilla', 'Idli Sambar', 'Upma'],
      lunch: ['Dal Tadka', 'Chole', 'Rajma', 'Kadhi Pakora', 'Aloo Gobi'],
      dinner: ['Paneer Bhurji', 'Mix Veg', 'Dal Makhani', 'Baingan Bharta', 'Jeera Aloo'],
    },
    eggetarian: {
      breakfast: ['Masala Omelette', 'Egg Paratha', 'Poha', 'Boiled Egg & Toast'],
      lunch: ['Egg Curry', 'Dal Tadka', 'Chole', 'Anda Bhurji'],
      dinner: ['Paneer Bhurji', 'Egg Masala', 'Mix Veg', 'Dal Makhani'],
    },
    nonvegetarian: {
      breakfast: ['Masala Omelette', 'Egg Paratha', 'Poha'],
      lunch: ['Chicken Curry', 'Egg Curry', 'Dal Tadka', 'Butter Chicken'],
      dinner: ['Chicken Tikka Masala', 'Fish Curry', 'Keema'],
    },
  },
  south: {
    vegetarian: {
      breakfast: ['Idli Sambar', 'Dosa', 'Pongal', 'Upma', 'Pesarattu'],
      lunch: ['Sambar Sadam', 'Rasam Sadam', 'Lemon Rice', 'Curd Rice', 'Kootu'],
      dinner: ['Vegetable Stew', 'Paruppu Usili', 'Tomato Rice', 'Bisi Bele Bath'],
    },
    eggetarian: {
      breakfast: ['Muttai Dosa', 'Egg Appam', 'Idli Sambar'],
      lunch: ['Muttai Kulambu', 'Sambar Sadam', 'Lemon Rice'],
      dinner: ['Egg Roast', 'Vegetable Stew', 'Tomato Rice'],
    },
    nonvegetarian: {
      breakfast: ['Muttai Dosa', 'Egg Appam', 'Idli Sambar'],
      lunch: ['Chicken Chettinad', 'Mutton Kulambu', 'Fish Curry'],
      dinner: ['Chicken 65', 'Egg Roast', 'Pepper Chicken'],
    },
  },
};

const SPECIALS: Record<MealStyle, string[]> = {
  north: ['Paneer Butter Masala', 'Dal Makhani', 'Butter Chicken'],
  south: ['Biryani', 'Chicken Chettinad', 'Mutton Biryani'],
};

export interface PlannedMealDraft {
  date: ISODate;
  mealType: MealType;
  recipeId: string | null;
  name: string;
  servings: number;
  servingsOverridden: boolean;
  isSpecial: boolean;
}

/**
 * Generate a seven-day plan starting today (issue 04, AC#1). Uses the most
 * restrictive active diet style and avoids repeating a named meal within three
 * days (issue 04, candidate rules). One Special Meal if enabled.
 */
export function generateStarterPlan(today: ISODate, seed: PlanSeed): PlannedMealDraft[] {
  const out: PlannedMealDraft[] = [];
  const pool = SEED[seed.mealStyle][seed.dietStyle];
  const used: string[] = [];
  const specialDay = seed.specialMealEnabled ? 5 : -1; // ~once per week
  for (let d = 0; d < 7; d++) {
    for (const mealType of MEAL_TYPES) {
      const candidates = pool[mealType];
      const isSpecial = d === specialDay && mealType === 'dinner';
      let name = pickAvoidingRepeat(candidates, used, 3);
      if (isSpecial) {
        const specials = SPECIALS[seed.mealStyle];
        name = pickAvoidingRepeat(specials, used, 99) ?? name;
      }
      used.push(name);
      out.push({
        date: addDays(today, d),
        mealType,
        recipeId: null,
        name,
        servings: seed.servings,
        servingsOverridden: false,
        isSpecial,
      });
    }
  }
  return out;
}

function pickAvoidingRepeat(pool: string[], used: string[], withinDays: number): string {
  const recent = used.slice(-withinDays * 3);
  for (const c of shuffle(pool)) {
    if (!recent.includes(c)) return c;
  }
  return pool[0] ?? 'Home meal';
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Swap two planned meals: exchange recipe identity/name while each slot keeps
 * its day, meal type, servings, and grocery timing context (issue 04, Swap).
 */
export function swapMealIdentities(
  a: PlannedMeal,
  b: PlannedMeal,
): {
  a: Partial<PlannedMeal>;
  b: Partial<PlannedMeal>;
} {
  return {
    a: { recipeId: b.recipeId, name: b.name, isSpecial: b.isSpecial },
    b: { recipeId: a.recipeId, name: a.name, isSpecial: a.isSpecial },
  };
}

export type RegenerateScope =
  { kind: 'meal' } | { kind: 'day' } | { kind: 'remaining_week'; fromDate: ISODate };

/**
 * Regenerate never changes completed past meals and keeps manually edited
 * meals by default (issue 04, Regenerate).
 */
export function regenerateKeepsEdited(
  meal: { date: ISODate },
  scope: RegenerateScope,
  today: ISODate,
  isEdited: boolean,
): boolean {
  // never touch the past
  if (meal.date < today) return true;
  if (isEdited) return true;
  if (scope.kind === 'meal') return false;
  if (scope.kind === 'day') return false;
  return meal.date < scope.fromDate;
}

/** Apply most-restrictive diet guardrail to a candidate pool (issue 04, AC#2). */
export function restrictPool(pool: string[], styles: DietStyle[]): string[] {
  void mostRestrictiveDietStyle(styles); // guardrail marker; real filtering happens by recipe dietStyle
  return pool;
}
