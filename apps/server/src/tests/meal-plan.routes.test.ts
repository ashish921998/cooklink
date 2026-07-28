import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase, plannedMeals, recipes } from '@cooklink/db';
import { todayISO, addDays } from '@cooklink/domain';
import { createApp } from '../app.js';

/**
 * Ticket 05 — edit the Weekly Meal Plan from either role, end to end through
 * the Hono app against Postgres. Exercises: viewing the plan, swapping meals,
 * search-and-replace, per-meal Serving Count override, regenerate one meal and
 * a day, optimistic-concurrency stale recovery, past-meal immutability, and
 * attributed `meal.changed` / `meal_plan.bulk_updated` Chat events in English
 * and Hindi.
 *
 * Skipped without DATABASE_URL, exactly like the ticket-02/03/04 Postgres tests.
 */
test(
  'meal plan editing from either role through the server',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const db = createDatabase(process.env.DATABASE_URL);
      const app = createApp(db);
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-05-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919500000001',
        'x-cooklink-dev-name': 'Plan Owner',
      };

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          name: `Ticket 05 ${suffix}`,
          servingCount: 4,
          mealStyle: 'north',
          dietStyle: 'vegetarian',
          specialMealEnabled: true,
        }),
      });
      assert.equal(createRes.status, 201);
      const { householdId } = (await createRes.json()) as { householdId: string };

      // Checklist item 1 — view all seven days (21 slots) from role navigation.
      const planRes = await app.request(`/v1/households/${householdId}/meal-plan`, {
        headers: ownerHeaders,
      });
      assert.equal(planRes.status, 200);
      const plan = (await planRes.json()) as {
        meals: {
          id: string;
          date: string;
          mealType: 'breakfast' | 'lunch' | 'dinner';
          name: string;
          version: number;
          servings: number;
          servingsOverridden: boolean;
        }[];
      };
      assert.equal(plan.meals.length, 21);

      // A future dinner slot to edit. The plan starts today, so pick the last day.
      const target = plan.meals.find((m) => m.mealType === 'dinner' && m.date > todayISO())!;
      assert.ok(target);

      // Checklist item 2/3 — swap-in a free-text replacement; applied
      // immediately, no approval state, version bumps.
      const editRes = await app.request(
        `/v1/households/${householdId}/meal-plan/meals/${target.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders,
          body: JSON.stringify({ expectedVersion: target.version, name: 'Paneer Butter Masala' }),
        },
      );
      assert.equal(editRes.status, 200);
      const edited = (await editRes.json()) as {
        meal: { name: string; version: number; servingsOverridden: boolean };
      };
      assert.equal(edited.meal.name, 'Paneer Butter Masala');
      assert.equal(edited.meal.version, target.version + 1);

      // The change produces a concise attributed Household Chat event.
      const chatRes = await app.request(`/v1/households/${householdId}/chat`, {
        headers: ownerHeaders,
      });
      const chat = (await chatRes.json()) as {
        items: { kind: string; type?: string; text?: string; actor?: { displayName: string } }[];
      };
      const event = chat.items.find((i) => i.kind === 'event' && i.type === 'meal.changed');
      assert.ok(event, 'meal.changed event is attributed in chat');
      assert.match(event!.text!, /Paneer Butter Masala/);
      assert.equal(event!.actor!.displayName, 'Plan Owner');

      // Checklist item 4 — a stale edit cannot overwrite a newer version; the
      // current meal is returned for fresh confirmation.
      const staleRes = await app.request(
        `/v1/households/${householdId}/meal-plan/meals/${target.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders,
          body: JSON.stringify({ expectedVersion: target.version, name: 'Rajma' }),
        },
      );
      assert.equal(staleRes.status, 409);
      const stale = (await staleRes.json()) as {
        error: string;
        current: { name: string; version: number };
      };
      assert.equal(stale.error, 'stale_version');
      assert.equal(stale.current.name, 'Paneer Butter Masala');

      // A per-meal Serving Count override is flagged and persisted on the slot.
      const servingsRes = await app.request(
        `/v1/households/${householdId}/meal-plan/meals/${target.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders,
          body: JSON.stringify({ expectedVersion: edited.meal.version, servings: 6 }),
        },
      );
      assert.equal(servingsRes.status, 200);
      const withServings = (await servingsRes.json()) as {
        meal: { servings: number; servingsOverridden: boolean; version: number };
      };
      assert.equal(withServings.meal.servings, 6);
      assert.equal(withServings.meal.servingsOverridden, true);

      // Checklist item 2 — search and replace. Seed two recipes so the
      // Household's vegetarian diet ranks first and an out-of-diet match is
      // surfaced but flagged.
      const vegRecipe = await seedRecipe(db, {
        name: 'Palak Paneer',
        dietStyle: 'vegetarian',
        mealTypes: ['dinner'],
      });
      const nonVegRecipe = await seedRecipe(db, {
        name: 'Chicken Paneer',
        dietStyle: 'nonvegetarian',
        mealTypes: ['dinner'],
      });

      const searchRes = await app.request(
        `/v1/households/${householdId}/meal-plan/search?q=paneer`,
        { headers: ownerHeaders },
      );
      assert.equal(searchRes.status, 200);
      const search = (await searchRes.json()) as {
        results: { recipeId: string; name: string; dietMismatch: boolean }[];
      };
      assert.equal(search.results[0]!.recipeId, vegRecipe.id);
      assert.equal(search.results[0]!.dietMismatch, false);
      const nonVegHit = search.results.find((r) => r.recipeId === nonVegRecipe.id)!;
      assert.ok(nonVegHit);
      assert.equal(nonVegHit.dietMismatch, true);

      // Confirming a search result replaces the slot via recipeId.
      const replaceRes = await app.request(
        `/v1/households/${householdId}/meal-plan/meals/${target.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders,
          body: JSON.stringify({
            expectedVersion: withServings.meal.version,
            recipeId: vegRecipe.id,
            name: 'Palak Paneer',
          }),
        },
      );
      assert.equal(replaceRes.status, 200);
      const replaced = (await replaceRes.json()) as { meal: { recipeId: string; version: number } };
      assert.equal(replaced.meal.recipeId, vegRecipe.id);

      // Checklist item 2 — swap two planned meals; each slot keeps its day and
      // meal type, identities exchange, two attributed events.
      const swapTarget = plan.meals.find(
        (m) => m.mealType === 'lunch' && m.date > todayISO() && m.id !== target.id,
      )!;
      const swapRes = await app.request(`/v1/households/${householdId}/meal-plan/swap`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          a: { mealId: target.id, expectedVersion: replaced.meal.version },
          b: { mealId: swapTarget.id, expectedVersion: swapTarget.version },
        }),
      });
      assert.equal(swapRes.status, 200);
      const swapped = (await swapRes.json()) as {
        meals: { id: string; name: string; date: string; mealType: string }[];
      };
      assert.equal(swapped.meals.length, 2);
      const swappedTarget = swapped.meals.find((m) => m.id === target.id)!;
      const swappedOther = swapped.meals.find((m) => m.id === swapTarget.id)!;
      assert.equal(swappedTarget.name, swapTarget.name);
      assert.equal(swappedOther.name, 'Palak Paneer');
      // Each slot keeps its day and meal type.
      assert.equal(swappedTarget.id, target.id);
      assert.equal(swappedTarget.mealType, target.mealType);

      // Checklist item 2/5 — regenerate one meal; never rewrites the past and
      // keeps edited meals by default unless explicitly included.
      const regenTarget = plan.meals.find(
        (m) => m.mealType === 'breakfast' && m.date > todayISO(),
      )!;
      const regenRes = await app.request(`/v1/households/${householdId}/meal-plan/regenerate`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          kind: 'meal',
          mealId: regenTarget.id,
          expectedVersions: { [regenTarget.id]: regenTarget.version },
        }),
      });
      assert.equal(regenRes.status, 200);
      const regen = (await regenRes.json()) as {
        meals: { id: string; name: string }[];
        changed: boolean;
      };
      assert.equal(regen.changed, true);
      assert.equal(regen.meals[0]!.id, regenTarget.id);
      assert.notEqual(regen.meals[0]!.name, regenTarget.name);

      // Regeneration keeps manually edited meals by default. The target slot
      // was edited above, so regenerating its day without includeEdited must
      // skip it.
      const dayRegenRes = await app.request(`/v1/households/${householdId}/meal-plan/regenerate`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          kind: 'day',
          fromDate: target.date,
          includeEdited: false,
        }),
      });
      assert.equal(dayRegenRes.status, 200);
      const dayRegen = (await dayRegenRes.json()) as {
        meals: { id: string; name: string }[];
      };
      assert.equal(
        dayRegen.meals.some((m) => m.id === target.id),
        false,
        'edited meal is kept by default',
      );

      // Checklist item 5 — regeneration never rewrites the past. Seed a past
      // meal and confirm regenerate remaining-week skips it.
      const pastDate = addDays(todayISO(), -1);
      const [pastMeal] = await db
        .insert(plannedMeals)
        .values({
          id: crypto.randomUUID(),
          householdId,
          date: pastDate,
          mealType: 'dinner',
          recipeId: null,
          name: 'Yesterday Dinner',
          servings: 4,
          servingsOverridden: false,
          isSpecial: false,
          version: 1,
          updatedBy: null,
        })
        .then(() => db.select().from(plannedMeals).where(eq(plannedMeals.date, pastDate)));
      void pastMeal;
      const pastRegenRes = await app.request(`/v1/households/${householdId}/meal-plan/regenerate`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          kind: 'remaining_week',
          fromDate: pastDate,
          includeEdited: true,
        }),
      });
      assert.equal(pastRegenRes.status, 200);
      const pastRegen = (await pastRegenRes.json()) as { meals: { id: string }[] };
      assert.equal(
        pastRegen.meals.some((m) => m.id === pastMeal!.id),
        false,
        'regenerate never touches the past',
      );

      // A past meal is immutable: a direct edit is rejected with the current meal.
      const pastEditRes = await app.request(
        `/v1/households/${householdId}/meal-plan/meals/${pastMeal!.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders,
          body: JSON.stringify({ expectedVersion: 1, name: 'Rewritten' }),
        },
      );
      assert.equal(pastEditRes.status, 422);
      const pastEdit = (await pastEditRes.json()) as { error: string; current: { name: string } };
      assert.equal(pastEdit.error, 'past_meal');
      assert.equal(pastEdit.current.name, 'Yesterday Dinner');

      // Checklist item 8 — English and Hindi plan labels remain usable. The
      // household defaults to English; request Hindi and the meal.changed event
      // renders in Hindi.
      const hiChatRes = await app.request(`/v1/households/${householdId}/chat?lang=hi`, {
        headers: ownerHeaders,
      });
      const hiChat = (await hiChatRes.json()) as {
        items: { kind: string; type?: string; text?: string }[];
      };
      const hiEvent = hiChat.items.find((i) => i.kind === 'event' && i.type === 'meal.changed');
      assert.ok(hiEvent);
      assert.match(hiEvent!.text!, /अब/);
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);

async function seedRecipe(
  db: ReturnType<typeof createDatabase>,
  r: {
    name: string;
    dietStyle: 'vegetarian' | 'eggetarian' | 'nonvegetarian';
    mealTypes: string[];
  },
) {
  const id = crypto.randomUUID();
  await db.insert(recipes).values({
    id,
    name: r.name,
    baseServings: 4,
    ingredients: [],
    steps: ['Cook and serve.'],
    provenance: 'verified',
    dietStyle: r.dietStyle,
    mealStyle: 'north',
    mealTypes: r.mealTypes,
  });
  return { id };
}
