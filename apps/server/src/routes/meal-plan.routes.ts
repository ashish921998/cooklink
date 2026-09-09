/**
 * Weekly Meal Plan API routes (ticket 05 / issue 04 — edit, swap, regenerate).
 *
 * The plan is the Household's active seven-day schedule of breakfast, lunch,
 * and dinner. Edits apply immediately (no approval state), are attributed as
 * `meal.changed` events in Household Chat, and are guarded by optimistic
 * concurrency so a stale edit can never overwrite a newer version. Past meals
 * are immutable. Nothing here authorizes a purchase.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import {
  brandId,
  decideMealEdit,
  mealChangedPayload,
  mealPlanBulkPayload,
  planRegeneration,
  rankSearchCandidates,
  scaleRecipe,
  swapMealIdentities,
  todayISO,
  type MealPatch,
  type PlannedMeal,
} from '@cooklink/domain';
import { households, plannedMeals, recipes, systemEvents } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { dispatchPushForEvent } from '../push-delivery.js';
import type { AppRouteContext, DbConnection } from './route-context.js';

type PlannedMealRow = typeof plannedMeals.$inferSelect;

/** Thrown inside the swap transaction so a stale side rolls back both writes. */
class StaleSwapError extends Error {
  constructor(readonly side: 'a' | 'b') {
    super('stale_swap');
    this.name = 'StaleSwapError';
  }
}

/** Mount the meal-plan routes: read, search, recipe, edit, swap, regenerate. */
export function registerMealPlanRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization, pushDispatcher, log } = ctx;

  app.get('/v1/households/:householdId/meal-plan', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'read_chat',
    );
    const meals = await db
      .select()
      .from(plannedMeals)
      .where(eq(plannedMeals.householdId, principal.householdId))
      .orderBy(asc(plannedMeals.date), asc(plannedMeals.mealType));
    return c.json({ meals: meals.map(serializePlannedMeal) });
  });

  /**
   * Search the recipe library for a manual meal replacement (ticket 05 / issue 04
   * — Search). Results are ranked so the Household's active diet comes first;
   * out-of-diet matches are still surfaced, flagged, so the member confirms the
   * mismatch rather than silently picking a profile-violating meal. Search text
   * never becomes Chat content; only a confirmed replacement emits an event.
   */
  app.get('/v1/households/:householdId/meal-plan/search', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_meal_plan',
    );
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ results: [] });
    const [household] = await db
      .select()
      .from(households)
      .where(eq(households.id, principal.householdId))
      .limit(1);
    const rows = await db.select().from(recipes);
    const candidates = rows.map((row) => ({
      id: brandId<'RecipeId'>(row.id),
      name: row.name,
      nameHi: row.nameHi,
      baseServings: row.baseServings,
      ingredients: row.ingredients as never,
      steps: row.steps,
      stepsHi: row.stepsHi,
      provenance: row.provenance,
      dietStyle: row.dietStyle,
      mealStyle: row.mealStyle,
      mealTypes: row.mealTypes as never,
    }));
    const ranked = rankSearchCandidates(q, candidates, household?.dietStyle ?? 'vegetarian');
    return c.json({
      results: ranked.map((r) => ({
        recipeId: r.recipe.id,
        name: r.recipe.name,
        nameHi: r.recipe.nameHi,
        dietStyle: r.recipe.dietStyle,
        dietMismatch: r.dietMismatch,
      })),
    });
  });

  /**
   * Read the recipe behind one planned meal. Free-text/generated slots may not
   * have a durable recipe yet; those return `recipe: null` so the mobile app
   * can show the meal honestly without inventing ingredients or instructions.
   */
  app.get('/v1/households/:householdId/meal-plan/meals/:mealId/recipe', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'read_chat',
    );
    const mealId = c.req.param('mealId');
    const [meal] = await db
      .select()
      .from(plannedMeals)
      .where(and(eq(plannedMeals.id, mealId), eq(plannedMeals.householdId, principal.householdId)))
      .limit(1);
    if (!meal) return c.json({ error: 'not_found' }, 404);
    if (!meal.recipeId) return c.json({ recipe: null });

    const [row] = await db.select().from(recipes).where(eq(recipes.id, meal.recipeId)).limit(1);
    if (!row) return c.json({ recipe: null });
    const scaled = scaleRecipe(
      {
        id: brandId<'RecipeId'>(row.id),
        name: row.name,
        nameHi: row.nameHi,
        baseServings: row.baseServings,
        ingredients: row.ingredients as never,
        steps: row.steps,
        stepsHi: row.stepsHi,
        provenance: row.provenance,
        dietStyle: row.dietStyle,
        mealStyle: row.mealStyle,
        mealTypes: row.mealTypes as never,
      },
      meal.servings,
    );
    return c.json({
      recipe: {
        id: scaled.id,
        name: scaled.name,
        nameHi: scaled.nameHi,
        steps: scaled.steps,
        stepsHi: scaled.stepsHi,
        provenance: scaled.provenance,
        servings: meal.servings,
        ingredients: scaled.scaledIngredients,
      },
    });
  });

  /**
   * Edit one planned meal: swap-in a search result, type a free-text
   * replacement, or change a per-meal Serving Count override (ticket 05 / issue
   * 04 — Search, manual replacement, Cook edits).
   *
   * The edit is applied immediately (no approval state), attributed to the actor
   * in Household Chat, and guarded by optimistic concurrency: a stale version is
   * rejected with the current meal so the caller re-renders and confirms fresh
   * (issue 04/06 — a stale edit cannot overwrite a newer version). Past meals
   * are immutable. Nothing here authorizes a purchase.
   */
  app.patch('/v1/households/:householdId/meal-plan/meals/:mealId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_meal_plan',
    );
    const mealId = c.req.param('mealId');
    const body: {
      expectedVersion?: number;
      name?: string;
      recipeId?: string | null;
      servings?: number;
      isSpecial?: boolean;
    } = await c.req.json().catch(() => ({}));
    if (body.expectedVersion === undefined || !Number.isFinite(body.expectedVersion)) {
      return c.json({ error: 'expected_version_required' }, 400);
    }

    const [current] = await db
      .select()
      .from(plannedMeals)
      .where(and(eq(plannedMeals.id, mealId), eq(plannedMeals.householdId, principal.householdId)))
      .limit(1);
    if (!current) return c.json({ error: 'not_found' }, 404);

    const patch: MealPatch = {};
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 128);
    if (body.recipeId !== undefined) patch.recipeId = body.recipeId;
    if (body.servings !== undefined) patch.servings = body.servings;
    if (body.isSpecial !== undefined) patch.isSpecial = body.isSpecial;

    const decision = decideMealEdit({
      current: toDomainPlannedMeal(current),
      request: {
        mealId: brandId<'PlannedMealId'>(mealId),
        expectedVersion: body.expectedVersion,
        patch,
      },
      actor: principal.membershipId,
      now: todayISO(),
    });
    if (!decision.ok) {
      const [fresh] = await db
        .select()
        .from(plannedMeals)
        .where(eq(plannedMeals.id, mealId))
        .limit(1);
      return c.json(
        {
          error: decision.reason,
          current: fresh ? serializePlannedMeal(fresh) : null,
        },
        decision.reason === 'past_meal' ? 422 : 409,
      );
    }

    const persisted = await applyMealPatch(db, mealId, principal.householdId, decision.result);
    if (!persisted) {
      // A concurrent write won the race between decide and write (item 4):
      // surface the freshest meal so the caller re-renders and confirms.
      const [fresh] = await db
        .select()
        .from(plannedMeals)
        .where(
          and(eq(plannedMeals.id, mealId), eq(plannedMeals.householdId, principal.householdId)),
        )
        .limit(1);
      return c.json(
        { error: 'stale_version', current: fresh ? serializePlannedMeal(fresh) : null },
        409,
      );
    }
    await recordMealChangedEvent(db, principal.householdId, principal.membershipId, persisted);
    // Fire-and-forget push for same-day meal changes (issue 12, AC#3).
    const today = todayISO();
    void dispatchPushForEvent(
      db,
      pushDispatcher,
      principal.householdId as string,
      principal.membershipId as string,
      {
        type: 'meal.changed',
        entityId: persisted.id,
        payload: mealChangedPayload(persisted.date, persisted.mealType, persisted.name),
      },
      {
        type: 'meal.changed',
        sameDayMeal: persisted.date === today,
      },
      `${persisted.mealType[0]!.toUpperCase()}${persisted.mealType.slice(1)} on ${persisted.date} is now ${persisted.name}.`,
      log,
    );
    return c.json({ meal: serializePlannedMeal(persisted) });
  });

  /**
   * Swap two planned meals: exchange recipe identity/name while each slot keeps
   * its day, meal type, Serving Count override, and grocery timing context
   * (issue 04 — Swap). Applied immediately and attributed with one
   * `meal.changed` event per affected meal. Optimistic concurrency applies to
   * each side; a stale side returns the current meal for fresh confirmation.
   */
  app.post('/v1/households/:householdId/meal-plan/swap', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_meal_plan',
    );
    const body: {
      a: { mealId: string; expectedVersion: number };
      b: { mealId: string; expectedVersion: number };
    } = await c.req.json().catch(() => ({}));
    if (!body.a?.mealId || !body.b?.mealId) return c.json({ error: 'meals_required' }, 400);

    const rows = await db
      .select()
      .from(plannedMeals)
      .where(
        and(
          eq(plannedMeals.householdId, principal.householdId),
          inArray(plannedMeals.id, [body.a.mealId, body.b.mealId]),
        ),
      );
    const aRow = rows.find((r) => r.id === body.a.mealId);
    const bRow = rows.find((r) => r.id === body.b.mealId);
    if (!aRow || !bRow) return c.json({ error: 'not_found' }, 404);

    const aDecision = decideMealEdit({
      current: toDomainPlannedMeal(aRow),
      request: {
        mealId: brandId<'PlannedMealId'>(aRow.id),
        expectedVersion: body.a.expectedVersion,
        patch: {},
      },
      actor: principal.membershipId,
      now: todayISO(),
    });
    const bDecision = decideMealEdit({
      current: toDomainPlannedMeal(bRow),
      request: {
        mealId: brandId<'PlannedMealId'>(bRow.id),
        expectedVersion: body.b.expectedVersion,
        patch: {},
      },
      actor: principal.membershipId,
      now: todayISO(),
    });
    if (!aDecision.ok || !bDecision.ok) {
      const failed = !aDecision.ok ? aDecision : bDecision;
      if (failed.ok) return c.json({ error: 'conflict' }, 409);
      return c.json(
        { error: failed.reason, current: serializeDomainPlannedMeal(failed.current) },
        failed.reason === 'past_meal' ? 422 : 409,
      );
    }

    const swap = swapMealIdentities(aDecision.result, bDecision.result);
    // Both meal writes and both attribution events run in one transaction so a
    // mid-swap failure leaves no half-swapped state and no orphan event. A
    // stale version on either side must THROW inside the transaction so the
    // whole swap is rolled back; returning normally would commit the side that
    // succeeded, leaving a half-swapped plan (item 4).
    let persistedA: PlannedMealRow | null = null;
    let persistedB: PlannedMealRow | null = null;
    let staleSide: 'a' | 'b' | null = null;
    try {
      const result = await db.transaction(async (tx) => {
        const a = await applyMealPatch(tx, aRow.id, principal.householdId, {
          ...aDecision.result,
          ...swap.a,
        });
        const b = await applyMealPatch(tx, bRow.id, principal.householdId, {
          ...bDecision.result,
          ...swap.b,
        });
        if (!a || !b) {
          // Throwing here forces a rollback of both writes so a stale side
          // cannot leave the other side committed.
          throw new StaleSwapError(!a ? 'a' : 'b');
        }
        await recordMealChangedEvent(tx, principal.householdId, principal.membershipId, a);
        await recordMealChangedEvent(tx, principal.householdId, principal.membershipId, b);
        return { persistedA: a, persistedB: b };
      });
      persistedA = result.persistedA;
      persistedB = result.persistedB;
    } catch (err) {
      if (err instanceof StaleSwapError) {
        staleSide = err.side;
      } else {
        throw err;
      }
    }
    if (staleSide) {
      const failedId = staleSide === 'a' ? aRow.id : bRow.id;
      const [fresh] = await db
        .select()
        .from(plannedMeals)
        .where(
          and(eq(plannedMeals.id, failedId), eq(plannedMeals.householdId, principal.householdId)),
        )
        .limit(1);
      return c.json(
        { error: 'stale_version', current: fresh ? serializePlannedMeal(fresh) : null },
        409,
      );
    }
    return c.json({
      meals: [serializePlannedMeal(persistedA!), serializePlannedMeal(persistedB!)],
    });
  });

  /**
   * Regenerate planned meals (ticket 05 / issue 04 — Regenerate). A person may
   * regenerate one meal, one day, or the remaining week from the selected day
   * forward. Regeneration never rewrites the past and keeps manually edited
   * meals by default; the body may opt into `includeEdited`. Bulk regeneration
   * produces one compact `meal_plan.bulk_updated` event.
   */
  app.post('/v1/households/:householdId/meal-plan/regenerate', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_meal_plan',
    );
    const body: {
      kind: 'meal' | 'day' | 'remaining_week';
      mealId?: string;
      fromDate?: string;
      includeEdited?: boolean;
      expectedVersions?: Record<string, number>;
    } = await c.req.json().catch(() => ({}));
    if (body.kind !== 'meal' && body.kind !== 'day' && body.kind !== 'remaining_week') {
      return c.json({ error: 'kind_invalid' }, 400);
    }

    const [household] = await db
      .select()
      .from(households)
      .where(eq(households.id, principal.householdId))
      .limit(1);
    const plan = (
      await db
        .select()
        .from(plannedMeals)
        .where(eq(plannedMeals.householdId, principal.householdId))
        .orderBy(asc(plannedMeals.date), asc(plannedMeals.mealType))
    ).map(toDomainPlannedMeal);

    const target = body.mealId ? plan.find((m) => m.id === body.mealId) : undefined;
    const result = planRegeneration(plan, {
      kind: body.kind,
      target,
      fromDate: body.fromDate,
      includeEdited: body.includeEdited === true,
      today: todayISO(),
      seed: household
        ? {
            dietStyle: household.dietStyle,
            mealStyle: household.mealStyle,
            servings: household.servingCount,
            specialMealEnabled: household.specialMealEnabled,
          }
        : undefined,
    });
    if (result.replace.length === 0) {
      return c.json({ meals: [], changed: false });
    }

    const expected = body.expectedVersions ?? {};
    const updated: PlannedMealRow[] = [];
    for (const slot of result.replace) {
      const [row] = await db
        .select()
        .from(plannedMeals)
        .where(
          and(
            eq(plannedMeals.id, slot.mealId),
            eq(plannedMeals.householdId, principal.householdId),
          ),
        )
        .limit(1);
      if (!row) continue;
      // Optimistic concurrency: the caller may pin each slot's version. A stale
      // slot is skipped (kept) and surfaced so the caller re-confirms it.
      if (expected[slot.mealId] !== undefined && row.version !== expected[slot.mealId]) {
        continue;
      }
      const next = await applyMealPatch(db, slot.mealId, principal.householdId, {
        ...toDomainPlannedMeal(row),
        recipeId: slot.draft.recipeId ? brandId<'RecipeId'>(slot.draft.recipeId) : null,
        name: slot.draft.name,
        isSpecial: slot.draft.isSpecial,
        servings: slot.draft.servings,
        version: row.version + 1,
        updatedBy: principal.membershipId,
        updatedAt: todayISO(),
      });
      // A null write means a concurrent edit won the race for this slot (item
      // 4): skip it like a stale slot so the caller can re-confirm it.
      if (next) updated.push(next);
    }

    if (updated.length > 0) {
      const fromDay = updated[0]!.date;
      await db.insert(systemEvents).values({
        id: randomUUID(),
        householdId: principal.householdId,
        type: 'meal_plan.bulk_updated',
        actorId: principal.membershipId,
        entityType: 'planned_meal',
        entityId: updated[0]!.id,
        payload: mealPlanBulkPayload(updated.length, fromDay),
      });
    }
    return c.json({ meals: updated.map(serializePlannedMeal), changed: updated.length > 0 });
  });
}

/**
 * Map a Drizzle planned-meal row onto the domain `PlannedMeal` so the
 * pure edit/regenerate rules in `@cooklink/domain` can decide on a typed value
 * (ticket 05 — the durable plan model is shared by both roles).
 */
export function toDomainPlannedMeal(row: PlannedMealRow): PlannedMeal {
  return {
    id: brandId<'PlannedMealId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    date: row.date,
    mealType: row.mealType,
    recipeId: row.recipeId ? brandId<'RecipeId'>(row.recipeId) : null,
    name: row.name,
    servings: row.servings,
    servingsOverridden: row.servingsOverridden,
    isSpecial: row.isSpecial,
    version: row.version,
    updatedBy: row.updatedBy ? brandId<'MembershipId'>(row.updatedBy) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a planned-meal row for the API. Field names match the domain model
 * so the mobile client renders one shape regardless of role (ticket 05).
 */
export function serializePlannedMeal(row: PlannedMealRow) {
  return {
    id: row.id,
    householdId: row.householdId,
    date: row.date,
    mealType: row.mealType,
    recipeId: row.recipeId,
    name: row.name,
    servings: row.servings,
    servingsOverridden: row.servingsOverridden,
    isSpecial: row.isSpecial,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a domain `PlannedMeal` (e.g. the `current` meal returned on a
 * rejected edit) using the same shape as `serializePlannedMeal`.
 */
export function serializeDomainPlannedMeal(meal: PlannedMeal) {
  return {
    id: meal.id,
    householdId: meal.householdId,
    date: meal.date,
    mealType: meal.mealType,
    recipeId: meal.recipeId,
    name: meal.name,
    servings: meal.servings,
    servingsOverridden: meal.servingsOverridden,
    isSpecial: meal.isSpecial,
    version: meal.version,
    updatedBy: meal.updatedBy,
    updatedAt: meal.updatedAt,
  };
}

/**
 * Persist a resolved meal edit (ticket 05). The UPDATE is guarded by the prior
 * version so a concurrent write cannot be silently overwritten. Returns the
 * freshest row on success, or `null` when the guard matched zero rows — i.e. a
 * concurrent edit won the race between the decide read and this write (item 4).
 * Callers must treat `null` as a stale conflict and surface the current meal.
 */
export async function applyMealPatch(
  db: DbConnection,
  mealId: string,
  householdId: string,
  next: PlannedMeal,
): Promise<PlannedMealRow | null> {
  const result = await db
    .update(plannedMeals)
    .set({
      recipeId: next.recipeId,
      name: next.name,
      servings: next.servings,
      servingsOverridden: next.servingsOverridden,
      isSpecial: next.isSpecial,
      version: next.version,
      updatedBy: next.updatedBy,
      updatedAt: new Date(next.updatedAt),
    })
    .where(
      and(
        eq(plannedMeals.id, mealId),
        eq(plannedMeals.householdId, householdId),
        eq(plannedMeals.version, next.version - 1),
      ),
    );
  if (result.rowCount !== 1) return null;
  const [persisted] = await db
    .select()
    .from(plannedMeals)
    .where(and(eq(plannedMeals.id, mealId), eq(plannedMeals.householdId, householdId)))
    .limit(1);
  return persisted ?? null;
}

/**
 * Attribute a `meal.changed` system event in Household Chat (ticket 05 / issue
 * 04 — changes apply immediately and create a concise attributed event). The
 * payload carries status only; never money (issue 06, AC#24). Accepts a
 * `DbConnection` so it can run inside the same transaction as the write.
 */
export async function recordMealChangedEvent(
  db: DbConnection,
  householdId: string,
  actorId: string,
  meal: PlannedMealRow,
) {
  await db.insert(systemEvents).values({
    id: randomUUID(),
    householdId,
    type: 'meal.changed',
    actorId,
    entityType: 'planned_meal',
    entityId: meal.id,
    payload: mealChangedPayload(meal.date, meal.mealType, meal.name),
  });
}
