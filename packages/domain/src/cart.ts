import type {
  CartNeedDay,
  GroceryRequest,
  ISODate,
  ISODateTime,
  MealType,
  PantryConfidence,
  PantryLedgerEntry,
  PlannedMeal,
  Recipe,
  SuggestedCartItem,
} from './domain-types.js';
import type { HouseholdId } from './ids.js';
import { type NetQuantity, classifyConfidence, emptyNeed, netAvailable } from './pantry.js';
import { dependableIngredients } from './recipes.js';
import type { Repository } from './repository.js';

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
  /**
   * Ingredient keys previously removed by a Member with `already_have` —
   * the cart treats them as likely available so they do not reappear (issue
   * 09, AC#7 — removal reasons improve later estimates).
   */
  memberAlreadyHave?: Set<string>;
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
  const alreadyHave = input.memberAlreadyHave ?? new Set<string>();
  for (const [ingredientKey, agg] of byIngredient) {
    if (alreadyHave.has(ingredientKey)) continue; // Member said they have it (AC#7)
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

  // 3. Approved Grocery Requests override the pantry (issue 09, AC#4).
  //    A Cook's request always appears in the cart — even if the pantry
  //    classified the ingredient as likely_available — because the Cook saw a
  //    real-world shortage the pantry does not know about.
  for (const req of input.approvedRequests) {
    // If the request names an ingredient already in the cart, attach to it.
    const matched = drafts.find(
      (d) => d.ingredientKey && d.freeTextItem == null && req.itemText.includes(d.ingredientKey),
    );
    if (matched && matched.groceryRequestId == null) {
      matched.groceryRequestId = req.id;
      continue;
    }
    drafts.push({
      ingredientKey: null, // free-text requests are matched to products at order time
      groceryRequestId: req.id,
      freeTextItem: req.itemText,
      needDay: 'today',
      affectedMeals: [], // a Cook's request is not tied to a specific planned meal
      confidence: 'unknown',
      checkAtHome: true,
    });
  }

  return drafts;
}

/** Convert drafts into persisted cart items (stable ids). */
export function toCartItems(householdId: HouseholdId, drafts: CartDraft[]): SuggestedCartItem[] {
  return drafts.map((d, i) => ({
    id: `${householdId}:${i}:${d.ingredientKey ?? d.freeTextItem ?? d.groceryRequestId}`,
    householdId,
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

// ---- consumption derivation (issue 09, AC#2) ----

/**
 * Derive deterministic consumption ledger entries from a Household's **past**
 * planned meals (date < today). Each dependable, normalizable recipe
 * ingredient produces one negative delta entry dated at the meal's calendar
 * date, so the Estimated Pantry reflects what has already been consumed.
 *
 * Future meals (today onward) do NOT produce consumption entries — their need
 * is computed directly by {@link buildSuggestedCart} and compared against the
 * pantry. This avoids double-counting: the pantry deducts only realized
 * consumption, and the cart compares the remaining availability against the
 * forward 3-day need.
 *
 * Non-dependable or unnormalizable ingredients (salt, oil, spices, "adjust to
 * taste") produce NO entry — they become `unknown` at cart time rather than
 * invented quantities (issue 09, AC#3).
 *
 * These entries are derived data: the caller replaces the entire
 * `consumption`-source ledger on every plan change so the pantry is always
 * consistent with the current plan (issue 09, AC#2 — recalculated after
 * structured plan changes).
 */
export function deriveConsumption(
  meals: PlannedMeal[],
  recipesById: Map<string, Recipe>,
  today: ISODate,
): Omit<PantryLedgerEntry, 'id' | 'householdId'>[] {
  const out: Omit<PantryLedgerEntry, 'id' | 'householdId'>[] = [];
  for (const meal of meals) {
    if (meal.date >= today) continue; // only past meals are "consumed"
    const recipe = meal.recipeId ? recipesById.get(meal.recipeId) : null;
    if (!recipe) continue;
    const factor = meal.servings / recipe.baseServings;
    for (const ing of dependableIngredients(recipe)) {
      if (!ing.ingredientKey || ing.quantity == null) continue;
      const scaled = ing.quantity * factor;
      out.push({
        ingredientKey: ing.ingredientKey,
        deltaG: ing.unit === 'g' ? -scaled : null,
        deltaMl: ing.unit === 'ml' ? -scaled : null,
        deltaCount: ing.unit === 'count' ? -scaled : null,
        source: 'consumption',
        perishable: false,
        freshnessDays: null,
        at: `${meal.date}T12:00:00.000Z`,
      });
    }
  }
  return out;
}

/**
 * Apply a delivered order's normalized quantities to the pantry ledger (issue
 * 09, AC#1 — only completed/delivered orders update the Estimated Pantry;
 * checkout success alone does not).
 *
 * Each line item produces one positive delta entry. Non-dependable or
 * unnormalizable items are skipped (they become `unknown`, never invented).
 */
export function deriveOrderDelivery(
  deliveredAt: ISODateTime,
  lines: { ingredientKey: string | null; quantity: number; unit: 'g' | 'ml' | 'count' | null }[],
): Omit<PantryLedgerEntry, 'id' | 'householdId'>[] {
  const out: Omit<PantryLedgerEntry, 'id' | 'householdId'>[] = [];
  for (const line of lines) {
    if (!line.ingredientKey || !line.unit) continue;
    out.push({
      ingredientKey: line.ingredientKey,
      deltaG: line.unit === 'g' ? line.quantity : null,
      deltaMl: line.unit === 'ml' ? line.quantity : null,
      deltaCount: line.unit === 'count' ? line.quantity : null,
      source: 'order_delivered',
      perishable: false,
      freshnessDays: null,
      at: deliveredAt,
    });
  }
  return out;
}

// ---- full cart refresh against a repository (issue 09) ----

/**
 * Recalculate the Estimated Pantry's consumption ledger and rebuild the
 * Suggested Grocery Cart for today plus the next two calendar days.
 *
 * This is the single orchestrator the server calls on `GET /suggested-cart`.
 * It:
 * 1. re-derives consumption entries from the full current plan and replaces
 *    the `consumption`-source ledger (issue 09, AC#2);
 * 2. loads the pantry ledger per ingredient needed in the 3-day horizon;
 * 3. loads approved Grocery Requests (issue 09, AC#4 — override);
 * 4. builds the cart with {@link buildSuggestedCart};
 * 5. persists it via `replaceSuggestedCart`;
 * 6. returns the persisted items.
 *
 * Household isolation is guaranteed by the repository's householdId scoping;
 * no other Household's meals, ledger, or requests are ever read or written.
 */
export async function refreshSuggestedCart(
  repo: Repository,
  householdId: HouseholdId,
  today: ISODate,
  now: Date = new Date(),
): Promise<SuggestedCartItem[]> {
  const horizonEnd = addDays(today, 2);

  // 1. Re-derive consumption from the full plan (past + future) and replace
  //    the consumption-source ledger so the pantry matches the current plan.
  const allMeals = await repo.listMealsForRange(householdId, '0000-01-01', '9999-12-31');
  const recipeIds = new Set<string>();
  for (const meal of allMeals) if (meal.recipeId) recipeIds.add(meal.recipeId);
  const recipesById = new Map<string, Recipe>();
  for (const recipeId of recipeIds) {
    const recipe = await repo.getRecipe(recipeId as Recipe['id']);
    if (recipe) recipesById.set(recipeId, recipe);
  }
  const consumption = deriveConsumption(allMeals, recipesById, today);
  await repo.replaceConsumptionLedger(householdId, consumption);

  // 2. Load meals in the 3-day horizon for the cart.
  const horizonMeals = allMeals.filter((m) => m.date >= today && m.date <= horizonEnd);

  // 3. Collect every ingredient key the cart might need (from horizon meals
  //    and approved requests) and load the pantry ledger for each.
  const ingredientKeys = new Set<string>();
  for (const meal of horizonMeals) {
    const recipe = meal.recipeId ? recipesById.get(meal.recipeId) : null;
    if (!recipe) continue;
    for (const ing of dependableIngredients(recipe)) {
      if (ing.ingredientKey) ingredientKeys.add(ing.ingredientKey);
    }
  }
  const approvedRequests = (await repo.listGroceryRequests(householdId, 'approved')).filter(
    (r) => r.status === 'approved',
  );

  const pantryByIngredient = new Map<string, PantryLedgerEntry[]>();
  for (const key of ingredientKeys) {
    pantryByIngredient.set(key, await repo.listPantryLedger(householdId, key));
  }

  // 4. Load the previous cart's Member removals so "already_have" reasons
  //    improve the next estimate (issue 09, AC#7). Ingredients a Member said
  //    they already have are treated as likely available and do not reappear.
  const previousCart = await repo.getSuggestedCart(householdId);
  const memberAlreadyHave = new Set<string>();
  for (const item of previousCart) {
    if (
      item.memberState === 'removed' &&
      item.removalReason === 'already_have' &&
      item.ingredientKey
    ) {
      memberAlreadyHave.add(item.ingredientKey);
    }
  }

  // 5. Build and persist the cart.
  const drafts = buildSuggestedCart({
    today,
    meals: horizonMeals,
    recipesById,
    pantryByIngredient,
    approvedRequests,
    memberAlreadyHave,
    now,
  });
  const items = toCartItems(householdId, drafts);
  return repo.replaceSuggestedCart(householdId, items);
}
