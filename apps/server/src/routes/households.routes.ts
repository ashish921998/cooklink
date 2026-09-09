/**
 * Household API routes: list, inspect, create, members, removal, access probe.
 *
 * A Household is the shared Cooklink space. Creating one seeds a starter
 * Weekly Meal Plan and grants the creator the Household Owner role
 * (`manage_membership`). Removing a member flips their membership to `removed`
 * and attributes a `membership.removed` event in Household Chat.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Hono } from 'hono';
import { brandId, generateStarterPlan, todayISO } from '@cooklink/domain';
import { households, memberships, plannedMeals, systemEvents } from '@cooklink/db';
import type { Database } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { validateMembershipRemoval } from '../membership-lifecycle.js';
import type { AppRouteContext } from './route-context.js';

type HouseholdRow = typeof households.$inferSelect;

/** Mount the household routes: list/get/create, members, removal, access probe. */
export function registerHouseholdRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization } = ctx;

  app.get('/v1/households', async (c) => {
    const user = c.get('authUser');
    const rows = await db
      .select({ membership: memberships, household: households })
      .from(memberships)
      .innerJoin(households, eq(households.id, memberships.householdId))
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.status, 'active'),
          isNull(households.closedAt),
        ),
      );

    return c.json({
      households: rows.map((row) => ({
        id: row.household.id,
        name: row.household.name,
        role: row.membership.role,
        servingCount: row.household.servingCount,
        mealStyle: row.household.mealStyle,
        dietStyle: row.household.dietStyle,
        defaultLanguage: row.household.defaultLanguage,
      })),
    });
  });

  app.get('/v1/households/:householdId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const [household] = await db
      .select()
      .from(households)
      .where(eq(households.id, principal.householdId))
      .limit(1);
    return c.json({ household, principal });
  });

  app.get('/v1/households/:householdId/members', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'manage_membership',
    );
    const rows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.householdId, householdId));
    return c.json({
      members: rows
        .filter((row) => row.status === 'active')
        .map((row) => ({
          id: row.id,
          role: row.role,
          status: row.status,
          notificationDefault: row.notificationDefault,
          joinedAt: row.joinedAt,
        })),
    });
  });

  app.post('/v1/households', async (c) => {
    const user = c.get('authUser');
    const body: {
      name?: string;
      servingCount?: number;
      mealStyle?: 'north' | 'south';
      dietStyle?: 'vegetarian' | 'eggetarian' | 'nonvegetarian';
      specialMealEnabled?: boolean;
    } = await c.req.json().catch(() => ({}));

    // The existing-household check and the creation run in one transaction
    // with a FOR UPDATE lock so two concurrent setup submissions cannot both
    // see no household and both create one (P2 — duplicate households under
    // concurrent retry). The lock serializes on the user's owner memberships.
    const setupResult = await db.transaction(async (tx) => {
      const [existingHome] = await tx
        .select({
          household: households,
          ownerMembershipId: memberships.id,
        })
        .from(memberships)
        .innerJoin(households, eq(households.id, memberships.householdId))
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.role, 'owner'),
            eq(memberships.status, 'active'),
            isNull(households.closedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (existingHome) {
        return { kind: 'existing' as const, home: existingHome };
      }

      const householdId = randomUUID();
      const ownerMembershipId = randomUUID();
      const servingCount = clampServingCount(body.servingCount);
      const mealStyle = body.mealStyle === 'south' ? 'south' : 'north';
      const dietStyle = normalizeDietStyle(body.dietStyle);
      const specialMealEnabled = body.specialMealEnabled === true;
      const planStart = todayISO();
      const meals = generateStarterPlan(planStart, {
        dietStyle,
        mealStyle,
        servings: servingCount,
        specialMealEnabled,
      }).map((meal) => ({
        id: randomUUID(),
        householdId,
        ...meal,
        // Starter meals are machine-generated, not manually edited: `updatedBy`
        // stays null so regeneration's "keep edited meals" rule only keeps
        // slots a person actually changed (issue 04 — Regenerate).
      }));
      await tx.insert(households).values({
        id: householdId,
        name: body.name?.trim() || 'My Home',
        servingCount,
        mealStyle,
        dietStyle,
        healthEmphasis: [],
        specialMealEnabled,
        defaultLanguage: 'en',
      });
      await tx.insert(memberships).values({
        id: ownerMembershipId,
        userId: user.id,
        householdId,
        role: 'owner',
        status: 'active',
        notificationDefault: 'all',
      });
      await tx.insert(plannedMeals).values(meals);
      return {
        kind: 'created' as const,
        householdId,
        planStart,
        mealCount: meals.length,
      };
    });

    if (setupResult.kind === 'existing') {
      const existingMeals = await ensureStarterPlan(db, setupResult.home.household);
      return c.json({
        householdId: setupResult.home.household.id,
        planStart: existingMeals[0]?.date ?? todayISO(),
        mealCount: existingMeals.length,
        resumed: true,
      });
    }
    return c.json(
      {
        householdId: setupResult.householdId,
        planStart: setupResult.planStart,
        mealCount: setupResult.mealCount,
      },
      201,
    );
  });

  /**
   * Owner removes a Household Member or Cook (issue 03). The membership flips to
   * `removed`, a `membership.removed` event is attributed in Household Chat, and
   * the next protected read by that person is denied so the app exits to a plain
   * explanation. An Owner cannot remove themselves this way.
   */
  app.delete('/v1/households/:householdId/members/:membershipId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const membershipId = c.req.param('membershipId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'manage_membership',
    );
    const [membership] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.householdId, householdId)))
      .limit(1);
    if (!membership) return c.json({ error: 'not_found' }, 404);
    const removalError = validateMembershipRemoval({
      actorMembershipId: principal.membershipId,
      targetMembershipId: membership.id,
      targetStatus: membership.status,
      targetRole: membership.role,
    });
    if (removalError === 'already_removed') return c.json({ ok: true, status: 'already_removed' });
    if (removalError === 'cannot_remove_self') {
      return c.json({ error: 'cannot_remove_self' }, 409);
    }

    await db.transaction(async (tx) => {
      // Prune any prior `removed` row for the same (userId, householdId) so the
      // unique index on (userId, householdId, status) is not violated when the
      // active row is flipped to `removed` (e.g. re-invite then re-remove).
      await tx
        .delete(memberships)
        .where(
          and(
            eq(memberships.userId, membership.userId),
            eq(memberships.householdId, householdId),
            eq(memberships.status, 'removed'),
          ),
        );
      await tx
        .update(memberships)
        .set({ status: 'removed', removedAt: new Date() })
        .where(
          and(
            eq(memberships.id, membershipId),
            eq(memberships.householdId, householdId),
            eq(memberships.status, 'active'),
          ),
        );
      await tx.insert(systemEvents).values({
        id: randomUUID(),
        householdId,
        type: 'membership.removed',
        actorId: principal.membershipId,
        entityType: 'membership',
        entityId: membershipId,
        payload: { role: membership.role },
      });
    });
    return c.json({ ok: true, status: 'removed' });
  });

  /**
   * Lightweight access probe for an open Household (issue 03 — removed/revoked
   * access immediately exits protected content). The client polls this when it
   * re-enters a Household so it can surface a plain explanation without first
   * rendering another Household's protected data.
   */
  app.get('/v1/households/:householdId/access', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    try {
      const principal = await authorization.authorize(
        brandId<'UserId'>(user.id),
        brandId<'HouseholdId'>(householdId),
      );
      return c.json({
        ok: true,
        role: principal.role,
        householdId,
        membershipId: principal.membershipId,
      });
    } catch {
      return c.json({ ok: false }, 403);
    }
  });
}

/** Seed a starter plan for a resumed household that has no meals yet. */
async function ensureStarterPlan(db: Database, household: HouseholdRow) {
  const existingMeals = await db
    .select()
    .from(plannedMeals)
    .where(eq(plannedMeals.householdId, household.id))
    .orderBy(asc(plannedMeals.date), asc(plannedMeals.mealType));
  if (existingMeals.length > 0) return existingMeals;

  const meals = generateStarterPlan(todayISO(), {
    dietStyle: household.dietStyle,
    mealStyle: household.mealStyle,
    servings: household.servingCount,
    specialMealEnabled: household.specialMealEnabled,
  }).map((meal) => ({
    id: randomUUID(),
    householdId: household.id,
    ...meal,
    // Machine-generated slots are not manual edits: `updatedBy` stays null so
    // regeneration's "keep edited meals" rule only keeps changed slots.
  }));
  await db.insert(plannedMeals).values(meals);
  return meals;
}

/** Clamp a Serving Count request to 1–12 diners, defaulting to 4. */
function clampServingCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 4;
  return Math.min(12, Math.max(1, Math.round(value)));
}

/** Normalize a diet-style request, defaulting to vegetarian. */
function normalizeDietStyle(
  value: string | undefined,
): 'vegetarian' | 'eggetarian' | 'nonvegetarian' {
  if (value === 'eggetarian' || value === 'nonvegetarian') return value;
  return 'vegetarian';
}
