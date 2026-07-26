import type {
  CartNeedDay,
  GroceryRequest,
  ISODate,
  MealType,
  PantryConfidence,
  PantryLedgerEntry,
  PlannedMeal,
  Recipe,
  SuggestedCartItem,
} from './types.js';
import { type NetQuantity, addNeed, classifyConfidence, emptyNeed, netAvailable } from './pantry.js';
import { dependableIngredients } from './recipes.js';

/**
 * Build the Suggested Grocery Cart for today plus the next two calendar days
 * (issue 05, AC#6 — not a rolling 72h window).
 *
 * It combines recipe needs, Estimated Pantry, and approved Grocery Requests:
 * - likely-available ingredients are omitted (covered at home);
 * - may-be-low / unknown ingredients are added with "Check at home";
 * - approved Cook Grocery Requests are always included (pantry override).
 */
export interface CartInput {
  today: ISODate;
  meals: PlannedMeal[]; // within the 3-day horizon
  recipesById: Map<string, Recipe>;
  pantryByIngredient: Map<string, PantryLedgerEntry[]>;
  approvedRequests: GroceryRequest[];
  now?: Date;
}

export interface CartDraft {
  ingredientKey: string | null;
  groceryRequestId: GroceryRequest['id'] | null;
  freeTextItem: string | null;
  needDay: CartNeedDay;
  affectedMeals: { date: ISODate; mealType: MealType; name: string }[];
  confidence: PantryConfidence;
  checkAtHome: boolean;
}

const DAY_OFFSET: CartNeedDay[] = ['today', 'tomorrow', 'day_after'];

export function needDayFor(today: ISODate, date: ISODate): CartNeedDay | null {
  const offset = dayDiff(today, date);
  if (offset < 0 || offset > 2) return null;
  return DAY_OFFSET[offset] ?? null;
}

export function buildSuggestedCart(input: CartInput): CartDraft[] {
  const now = input.now ?? new Date();
  const horizonEnd = addDays(input.today, 2);
  const drafts: CartDraft[] = [];

  // 1. Aggregate dependable recipe needs per ingredient across the horizon.
  interface NeedAgg {
    need: NetQuantity;
    unit: 'g' | 'ml' | 'count';
    meals: { date: ISODate; mealType: MealType; name: string }[];
  }
  const byIngredient = new Map<string, NeedAgg>();

  for (const meal of input.meals) {
    if (meal.date < input.today || meal.date > horizonEnd) continue;
    const recipe = meal.recipeId ? input.recipesById.get(meal.recipeId) : null;
    if (!recipe) continue;
    const factor = meal.servings / recipe.baseServings;
    for (const ing of dependableIngredients(recipe)) {
      if (!ing.ingredientKey || ing.quantity == null) continue;
      const agg = byIngredient.get(ing.ingredientKey) ?? {
        need: emptyNeed(),
        unit: ing.unit ?? 'count',
        meals: [],
      };
      const scaled = ing.quantity * factor;
      if (ing.unit === 'g') agg.need.g += scaled;
      else if (ing.unit === 'ml') agg.need.ml += scaled;
      else agg.need.count += scaled;
      agg.need.hasData = true;
      agg.unit = ing.unit ?? 'count';
      agg.meals.push({ date: meal.date, mealType: meal.mealType, name: meal.name });
      byIngredient.set(ing.ingredientKey, agg);
    }
  }

  // 2. Compare each need against the Estimated Pantry.
  for (const [ingredientKey, agg] of byIngredient) {
    const entries = input.pantryByIngredient.get(ingredientKey) ?? [];
    const net = netAvailable(entries, now);
    const confidence = classifyConfidence(net, agg.need);
    if (confidence === 'likely_available') continue; // covered at home
    const earliest = agg.meals.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
    const nd = earliest ? needDayFor(input.today, earliest.date) : 'today';
    drafts.push({
      ingredientKey,
      groceryRequestId: null,
      freeTextItem: null,
      needDay: nd ?? 'today',
      affectedMeals: agg.meals,
      confidence,
      checkAtHome: true,
    });
  }

  // 3. Approved Grocery Requests override the pantry (issue 05, AC#5).
  for (const req of input.approvedRequests) {
    const key = req.quantityText ? null : null; // matching is deferred to order time
    const existing = req.quantityText
      ? null
      : drafts.find((d) => d.groceryRequestId === req.id);
    if (existing) continue;
    // If the request names an ingredient already in the cart, attach to it.
    const matched = drafts.find(
      (d) => d.ingredientKey && d.freeTextItem == null && req.itemText.includes(d.ingredientKey),
    );
    if (matched && matched.groceryRequestId == null) {
      matched.groceryRequestId = req.id;
      continue;
    }
    const entries = key ? input.pantryByIngredient.get(key) ?? [] : [];
    const confidence = key ? classifyConfidence(netAvailable(entries, now), emptyNeed()) : 'unknown';
    drafts.push({
      ingredientKey: key,
      groceryRequestId: req.id,
      freeTextItem: req.itemText,
      needDay: 'today',
      affectedMeals: [],
      confidence,
      checkAtHome: true,
    });
  }

  return drafts;
}

/** Convert drafts into persisted cart items (stable ids). */
export function toCartItems(
  householdId: string,
  drafts: CartDraft[],
): Omit<SuggestedCartItem, 'householdId'>[] {
  return drafts.map((d, i) => ({
    id: `${householdId}:${i}:${d.ingredientKey ?? d.freeTextItem ?? d.groceryRequestId}`,
    householdId: householdId as SuggestedCartItem['householdId'],
    ingredientKey: d.ingredientKey,
    groceryRequestId: d.groceryRequestId,
    freeTextItem: d.freeTextItem,
    needDay: d.needDay,
    affectedMeals: d.affectedMeals,
    confidence: d.confidence,
    memberState: 'pending',
    removalReason: null,
  }));
}

// ---- date helpers (calendar days, no timezone gymnastics) ----

export function addDays(iso: ISODate, days: number): ISODate {
  const parts = iso.split('-');
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  dt.setUTCDate(dt.getUTCDate() + days);
  return toISO(dt);
}

function dayDiff(a: ISODate, b: ISODate): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  return Math.round((db - da) / 86_400_000);
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function todayISO(now: Date = new Date()): ISODate {
  return toISO(now);
}
