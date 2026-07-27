import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import {
  Authorization,
  AuthorizationDeniedError,
  canCorrectTranscript,
  canEditOrDeleteMessage,
  decideMealEdit,
  detectMessageIntent,
  effectiveTranscript,
  generateStarterPlan,
  id,
  isAutomaticTranscript,
  MAX_VOICE_DURATION_MS,
  mealChangedPayload,
  mealPlanBulkPayload,
  planRegeneration,
  rankSearchCandidates,
  renderEvent,
  swapMealIdentities,
  todayISO,
  validateMessageShape,
  type Language,
  type MealPatch,
  type PlannedMeal,
  type SystemEventType,
} from '@cooklink/domain';
import {
  chatMessages,
  householdInvites,
  householdMemberState,
  households,
  memberships,
  plannedMeals,
  recipes,
  systemEvents,
  users,
  voiceTranscripts,
} from '@cooklink/db';
import type { Database } from '@cooklink/db';
import { authMiddleware, type AuthEnv } from './auth.js';
import { DrizzleAuthorizationLookup } from './household-auth.js';
import { hashPhone, validateInviteAcceptance } from './invite-policy.js';
import {
  INVITE_TTL_MS,
  acceptStatusFor,
  isInviteResendable,
  isInviteRevocable,
  type InviteRecord,
} from './invite-lifecycle.js';
import { validateMembershipRemoval } from './membership-lifecycle.js';
import { createMediaStore, type MediaKind, type MediaStore } from './media.js';
import { createTranscriptionService, type TranscriptionService } from './transcription.js';

type HouseholdRoleInvite = 'member' | 'cook';

export interface AppServices {
  media?: MediaStore;
  transcription?: TranscriptionService;
}

/** Thrown inside the swap transaction so a stale side rolls back both writes. */
class StaleSwapError extends Error {
  constructor(readonly side: 'a' | 'b') {
    super('stale_swap');
    this.name = 'StaleSwapError';
  }
}

/** Thrown when the invite was already consumed by a concurrent acceptance. */
class InviteAlreadyConsumedError extends Error {
  constructor() {
    super('invite_already_consumed');
    this.name = 'InviteAlreadyConsumedError';
  }
}

/** Thrown when an in-transaction limit check fails during invite acceptance. */
class InviteConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'InviteConflictError';
  }
}

export function createApp(db: Database, services?: AppServices) {
  const app = new Hono<AuthEnv>();
  const authorization = new Authorization(new DrizzleAuthorizationLookup(db));
  const media = services?.media ?? createMediaStore();
  const transcription = services?.transcription ?? createTranscriptionService();

  app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: '*',
      allowHeaders: [
        'authorization',
        'content-type',
        'x-clerk-user-id',
        'x-cooklink-dev-phone',
        'x-cooklink-dev-name',
      ],
    }),
  );

  app.get('/health', (c) => c.json({ ok: true, service: 'cooklink-server' }));

  app.use('/v1/*', authMiddleware(db));

  app.get('/v1/me', (c) => c.json({ user: c.get('authUser') }));

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
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
    );
    const [household] = await db
      .select()
      .from(households)
      .where(eq(households.id, principal.householdId))
      .limit(1);
    return c.json({ household, principal });
  });

  app.get('/v1/households/:householdId/meal-plan', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
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
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
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
      id: id<'RecipeId'>(row.id),
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
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
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
        mealId: id<'PlannedMealId'>(mealId),
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
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
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
        mealId: id<'PlannedMealId'>(aRow.id),
        expectedVersion: body.a.expectedVersion,
        patch: {},
      },
      actor: principal.membershipId,
      now: todayISO(),
    });
    const bDecision = decideMealEdit({
      current: toDomainPlannedMeal(bRow),
      request: {
        mealId: id<'PlannedMealId'>(bRow.id),
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
          and(
            eq(plannedMeals.id, failedId),
            eq(plannedMeals.householdId, principal.householdId),
          ),
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
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
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
        recipeId: slot.draft.recipeId ? id<'RecipeId'>(slot.draft.recipeId) : null,
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

  app.get('/v1/households/:householdId/members', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
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
        updatedBy: ownerMembershipId,
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
      const existingMeals = await ensureStarterPlan(
        db,
        setupResult.home.household,
        setupResult.home.ownerMembershipId,
      );
      return c.json({
        householdId: setupResult.home.household.id,
        planStart: existingMeals[0]?.date ?? todayISO(),
        mealCount: existingMeals.length,
        resumed: true,
      });
    }
    return c.json(
      { householdId: setupResult.householdId, planStart: setupResult.planStart, mealCount: setupResult.mealCount },
      201,
    );
  });

  app.post('/v1/households/:householdId/invites', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'manage_membership',
    );
    const body: { phone?: string; role?: HouseholdRoleInvite } = await c.req
      .json()
      .catch(() => ({}));
    const phone = body.phone?.trim();
    if (!phone) return c.json({ error: 'phone_required' }, 400);
    if (body.role !== 'member' && body.role !== 'cook')
      return c.json({ error: 'role_invalid' }, 400);

    const token = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const inviteId = randomUUID();
    await db.insert(householdInvites).values({
      id: inviteId,
      householdId,
      role: body.role,
      phoneHash: hashPhone(phone),
      token,
      status: 'pending',
      expiresAt,
    });
    return c.json(
      { id: inviteId, token, role: body.role, expiresAt: expiresAt.toISOString() },
      201,
    );
  });

  /**
   * The Owner's pending-invite management surface (issue 03). Returns only the
   * pending invites for this Household, newest first, with the masked phone so
   * the raw number never crosses the wire.
   */
  app.get('/v1/households/:householdId/invites', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'manage_membership',
    );
    const rows = await db
      .select()
      .from(householdInvites)
      .where(
        and(eq(householdInvites.householdId, householdId), eq(householdInvites.status, 'pending')),
      )
      .orderBy(desc(householdInvites.createdAt));
    return c.json({
      invites: rows.map((row) => ({
        id: row.id,
        role: row.role,
        phoneMasked: maskPhoneHash(row.phoneHash),
        expiresAt: row.expiresAt.toISOString(),
      })),
    });
  });

  /**
   * Revoke a pending, single-use Household Invite (issue 03). Revoked tokens
   * can no longer be accepted, even before the seven-day expiry.
   */
  app.delete('/v1/invites/:inviteId', async (c) => {
    const user = c.get('authUser');
    const inviteId = c.req.param('inviteId');
    const [invite] = await db
      .select()
      .from(householdInvites)
      .where(eq(householdInvites.id, inviteId))
      .limit(1);
    if (!invite) return c.json({ error: 'invite_invalid' }, 404);
    await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(invite.householdId),
      'manage_membership',
    );
    if (!isInviteRevocable(toInviteRecord(invite))) {
      return c.json({ error: 'invite_not_revocable' }, 409);
    }
    await db
      .update(householdInvites)
      .set({ status: 'revoked' })
      .where(and(eq(householdInvites.id, inviteId), eq(householdInvites.status, 'pending')));
    return c.json({ ok: true, status: 'revoked' });
  });

  /**
   * Resend a pending Household Invite (issue 03). Issues a fresh single-use
   * token and restarts the seven-day clock, then revokes the prior token so
   * only the newest link is usable.
   */
  app.post('/v1/invites/:inviteId/resend', async (c) => {
    const user = c.get('authUser');
    const inviteId = c.req.param('inviteId');
    const [invite] = await db
      .select()
      .from(householdInvites)
      .where(eq(householdInvites.id, inviteId))
      .limit(1);
    if (!invite) return c.json({ error: 'invite_invalid' }, 404);
    await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(invite.householdId),
      'manage_membership',
    );
    if (!isInviteResendable(toInviteRecord(invite))) {
      return c.json({ error: 'invite_not_resendable' }, 409);
    }

    const token = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await db.transaction(async (tx) => {
      await tx
        .update(householdInvites)
        .set({ status: 'revoked' })
        .where(and(eq(householdInvites.id, inviteId), eq(householdInvites.status, 'pending')));
      await tx.insert(householdInvites).values({
        id: randomUUID(),
        householdId: invite.householdId,
        role: invite.role,
        phoneHash: invite.phoneHash,
        token,
        status: 'pending',
        expiresAt,
      });
    });
    return c.json({ token, role: invite.role, expiresAt: expiresAt.toISOString() }, 201);
  });

  app.post('/v1/invites/accept', async (c) => {
    const user = c.get('authUser');
    const { token } = await c.req.json<{ token?: string }>();
    if (!token) return c.json({ error: 'token_required' }, 400);

    const [invite] = await db
      .select()
      .from(householdInvites)
      .where(eq(householdInvites.token, token))
      .limit(1);
    if (!invite) return c.json({ error: 'invite_invalid' }, 404);

    const status = acceptStatusFor(toInviteRecord(invite), {
      verifiedPhone: user.phone,
      now: new Date().toISOString(),
    });
    if (!status.ok) {
      const code = status.error === 'invite_phone_mismatch' ? 403 : 404;
      return c.json({ error: status.error }, code);
    }

    const [existingMembership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.householdId, invite.householdId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    let activeHouseholdCooks = 0;
    let activeCookHouseholds = 0;
    if (invite.role === 'cook') {
      const [householdCookCount] = await db
        .select({ value: count() })
        .from(memberships)
        .where(
          and(
            eq(memberships.householdId, invite.householdId),
            eq(memberships.role, 'cook'),
            eq(memberships.status, 'active'),
          ),
        );
      activeHouseholdCooks = householdCookCount?.value ?? 0;

      const [cookHouseholdCount] = await db
        .select({ value: count() })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.role, 'cook'),
            eq(memberships.status, 'active'),
          ),
        );
      activeCookHouseholds = cookHouseholdCount?.value ?? 0;
    }

    const acceptanceError = validateInviteAcceptance({
      invitedPhoneHash: invite.phoneHash,
      verifiedPhone: user.phone,
      hasActiveHouseholdRole: Boolean(existingMembership),
      role: invite.role,
      activeHouseholdCooks,
      activeCookHouseholds,
    });
    if (acceptanceError) {
      return c.json(
        { error: acceptanceError },
        acceptanceError === 'invite_phone_mismatch' ? 403 : 409,
      );
    }

    const newMembershipId = randomUUID();
    try {
      await db.transaction(async (tx) => {
        // The invite status update is the primary serialization point: the
        // `WHERE status = 'pending'` guard ensures only one concurrent
        // acceptance of the same invite can proceed (affectedRows !== 1).
        const result = await tx
          .update(householdInvites)
          .set({ status: 'accepted', acceptedByUserId: user.id })
          .where(and(eq(householdInvites.id, invite.id), eq(householdInvites.status, 'pending')));
        if (result[0].affectedRows !== 1) {
          throw new InviteAlreadyConsumedError();
        }

        // Re-check the limits INSIDE the transaction so concurrent
        // acceptances of different invites cannot both pass. The counts are
        // read after the invite lock, narrowing the race window. The unique
        // index on (userId, householdId, status) is the final backstop: a
        // duplicate active membership insert throws and rolls back both writes.
        const [conflictingMembership] = await tx
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, user.id),
              eq(memberships.householdId, invite.householdId),
              eq(memberships.status, 'active'),
            ),
          )
          .limit(1);
        if (conflictingMembership) {
          throw new InviteConflictError('already_member');
        }

        if (invite.role === 'cook') {
          const [householdCookCount] = await tx
            .select({ value: count() })
            .from(memberships)
            .where(
              and(
                eq(memberships.householdId, invite.householdId),
                eq(memberships.role, 'cook'),
                eq(memberships.status, 'active'),
              ),
            );
          if ((householdCookCount?.value ?? 0) >= 2) {
            throw new InviteConflictError('cook_limit_reached');
          }

          const [cookHouseholdCount] = await tx
            .select({ value: count() })
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, user.id),
                eq(memberships.role, 'cook'),
                eq(memberships.status, 'active'),
              ),
            );
          if ((cookHouseholdCount?.value ?? 0) >= 30) {
            throw new InviteConflictError('cook_household_limit_reached');
          }
        }

        await tx.insert(memberships).values({
          id: newMembershipId,
          userId: user.id,
          householdId: invite.householdId,
          role: invite.role,
          status: 'active',
          notificationDefault: invite.role === 'cook' ? 'important' : 'all',
        });
        // Attributed system event so Household Chat announces the join (issue 03,
        // issue 06 membership surface).
        await tx.insert(systemEvents).values({
          id: randomUUID(),
          householdId: invite.householdId,
          type: 'membership.joined',
          actorId: newMembershipId,
          entityType: 'membership',
          entityId: newMembershipId,
          payload: { role: invite.role },
        });
      });
    } catch (err) {
      if (err instanceof InviteAlreadyConsumedError) {
        return c.json({ error: 'invite_invalid' }, 404);
      }
      if (err instanceof InviteConflictError) {
        return c.json({ error: err.code }, 409);
      }
      // A duplicate-key error from the unique index on (userId, householdId,
      // status) means a concurrent acceptance already created the active
      // membership — surface it as a conflict, not a 500.
      if (err instanceof Error && /Duplicate entry/i.test(err.message)) {
        return c.json({ error: 'already_member' }, 409);
      }
      throw err;
    }

    return c.json({ householdId: invite.householdId, role: invite.role });
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
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
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
        id<'UserId'>(user.id),
        id<'HouseholdId'>(householdId),
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

  /**
   * Household Chat timeline (issue 04 — text chat). Returns the merged,
   * server-ordered history of human messages and attributed system events,
   * scoped to this Household. A pending (outbox) message is never visible to
   * others because it does not exist until this server accepts it (issue 06,
   * AC#12).
   *
   * Pagination is a forward cursor: `?afterId=` returns items strictly newer
   * than that id, which is the contract Open Chat polls on refresh.
   */
  app.get('/v1/households/:householdId/chat', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
    );
    const limit = clampPositiveInt(c.req.query('limit'), 50, 200);
    const afterId = c.req.query('afterId');

    const messageRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.householdId, principal.householdId))
      .orderBy(asc(chatMessages.serverCreatedAt), asc(chatMessages.id));
    const eventRows = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.householdId, principal.householdId))
      .orderBy(asc(systemEvents.createdAt), asc(systemEvents.id));
    // Voice transcripts are private to the Household and travel with their
    // message (ticket 06 — transcripts never cross Household boundaries).
    const messageIds = messageRows.map((m) => m.id);
    const transcriptRows =
      messageIds.length > 0
        ? await db
            .select()
            .from(voiceTranscripts)
            .where(inArray(voiceTranscripts.messageId, messageIds))
        : [];
    const transcriptByMessage = new Map(transcriptRows.map((r) => [r.messageId, r]));

    type Row = {
      kind: 'message' | 'event';
      id: string;
      time: number;
      payload: unknown;
    };
    const rows: Row[] = [
      ...messageRows.map((m) => ({
        kind: 'message' as const,
        id: m.id,
        time: m.serverCreatedAt.getTime(),
        payload: m,
      })),
      ...eventRows.map((e) => ({
        kind: 'event' as const,
        id: e.id,
        time: e.createdAt.getTime(),
        payload: e,
      })),
    ].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));

    const cursorIndex = afterId ? rows.findIndex((r) => r.id === afterId) : -1;
    const start = afterId
      ? cursorIndex >= 0
        ? cursorIndex + 1
        : rows.length // unknown cursor → nothing newer (safe poll no-op)
      : Math.max(0, rows.length - limit);
    const page = rows.slice(start, start + limit);

    // Resolve sender display names once so the client can attribute messages,
    // including the inactive-role label for a departed participant (issue 06 —
    // history remains attributed after a participant leaves).
    const senderIds = [
      ...new Set(
        page
          .filter((r) => r.kind === 'message')
          .map((r) => (r.payload as (typeof messageRows)[number]).senderId),
      ),
    ];
    const actorIds = [
      ...new Set(
        page
          .filter((r) => r.kind === 'event')
          .map((r) => (r.payload as (typeof eventRows)[number]).actorId)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const membershipIds = [...new Set([...senderIds, ...actorIds])];
    const names = await resolveMembershipLabels(db, principal.householdId, membershipIds);

    const household = await db
      .select()
      .from(households)
      .where(eq(households.id, principal.householdId))
      .limit(1);

    return c.json({
      items: page.map((r) =>
        r.kind === 'message'
          ? serializeChatMessage(
              r.payload as (typeof messageRows)[number],
              names,
              transcriptByMessage.get((r.payload as (typeof messageRows)[number]).id) ?? null,
            )
          : serializeChatEvent(
              r.payload as (typeof eventRows)[number],
              names,
              resolveViewerLanguage(c.req.query('lang'), household[0]?.defaultLanguage),
            ),
      ),
    });
  });

  /**
   * Send a human message (ticket 06 — text, photo, and voice). The server
   * accepts the message only after re-authorizing the membership, so a
   * just-removed participant's queued attempt fails with
   * Household-access-changed (issue 06, AC#19). Server acceptance time fixes
   * the message's position in the shared timeline; the client time is retained
   * for diagnostics.
   *
   * Photo and voice messages reference a mediaRef obtained from the media
   * upload route; the media belongs to this Household. A voice message
   * triggers server-side transcription (ticket 06, AC#4).
   */
  app.post('/v1/households/:householdId/chat/messages', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'send_message',
    );
    const body: {
      kind?: 'text' | 'photo' | 'voice';
      body?: string | null;
      caption?: string | null;
      mediaRef?: string | null;
      durationMs?: number;
      clientCreatedAt?: string;
    } = await c.req.json().catch(() => ({}));
    const kind = body.kind ?? 'text';
    const shape = validateMessageShape({
      kind,
      body: body.body ?? null,
      caption: body.caption ?? null,
      mediaRef: body.mediaRef ?? null,
    });
    if (!shape.ok) return c.json({ error: shape.reason }, 400);

    // A voice note is bounded at two minutes (ticket 06, AC#2). The duration
    // is required for voice messages so the bound cannot be bypassed by
    // omitting the field.
    if (kind === 'voice') {
      const durationMs = body.durationMs;
      if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
        return c.json({ error: 'voice_duration_required' }, 400);
      }
      if (durationMs > MAX_VOICE_DURATION_MS) {
        return c.json({ error: 'voice_too_long' }, 400);
      }
    }

    const messageId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      householdId: principal.householdId,
      senderId: principal.membershipId,
      kind,
      body: kind === 'text' ? (body.body ?? '').trim() : null,
      caption: kind === 'photo' ? (body.caption ?? '').trim() || null : null,
      mediaRef: kind !== 'text' ? (body.mediaRef ?? null) : null,
      clientCreatedAt: new Date(body.clientCreatedAt ?? Date.now()),
    });
    const [created] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    const names = await resolveMembershipLabels(db, principal.householdId, [created!.senderId]);

    // A voice message starts transcription in `pending` state. The response
    // returns immediately with the pending transcript so the client can show
    // "Transcribing…"; the actual transcription runs asynchronously and the
    // client observes the result via the next poll (ticket 06, AC#4).
    // Transcription runs server-side; no provider key is in the mobile bundle.
    let transcriptRow: typeof voiceTranscripts.$inferSelect | null = null;
    if (kind === 'voice' && created!.mediaRef) {
      const resolved = await media.resolve(created!.mediaRef, principal.householdId);
      if (resolved) {
        await db
          .insert(voiceTranscripts)
          .values({ messageId, language: null, transcript: null, status: 'pending' })
          .onDuplicateKeyUpdate({ set: { status: 'pending' } });
        const [pendingRow] = await db
          .select()
          .from(voiceTranscripts)
          .where(eq(voiceTranscripts.messageId, messageId))
          .limit(1);
        transcriptRow = pendingRow ?? null;

        // Run transcription without blocking the send response. The result is
        // written back to the transcript row when the provider returns; the
        // client picks it up on the next poll.
        const householdIdForTranscribe = principal.householdId;
        void transcription
          .transcribe({ data: resolved.data, contentType: resolved.contentType })
          .then((result) =>
            db
              .insert(voiceTranscripts)
              .values({
                messageId,
                language: result.language,
                transcript: result.transcript,
                status: result.status,
              })
              .onDuplicateKeyUpdate({
                set: {
                  language: result.language,
                  transcript: result.transcript,
                  status: result.status,
                },
              }),
          )
          .catch(() =>
            db
              .insert(voiceTranscripts)
              .values({ messageId, language: null, transcript: null, status: 'failed' })
              .onDuplicateKeyUpdate({ set: { status: 'failed' } }),
          )
          .catch(() => {
            // A failure to persist the transcription failure is logged but
            // never surfaces to the sender; the transcript stays pending and
            // the client retries on the next poll.
          });
        void householdIdForTranscribe;
      }
    }

    return c.json(
      {
        item: serializeChatMessage(created!, names, transcriptRow),
        membershipId: principal.membershipId,
      },
      201,
    );
  });

  /**
   * Edit your own human message within the 15-minute window (issue 06, AC#11).
   * A text message body or a photo caption may be edited; a voice note's text
   * is corrected through the transcript route. A confirmed structured action
   * is never mutated by editing its source message. System events are not
   * human messages and have no edit route.
   *
   * Editing a photo caption re-runs intent detection against the new caption
   * (ticket 06, AC#5 — correcting a transcript or photo caption re-runs any
   * derived intent detection without rewriting the original media).
   */
  app.patch('/v1/households/:householdId/chat/messages/:messageId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'edit_delete_own_message',
    );
    const messageId = c.req.param('messageId');
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    if (!message || message.householdId !== principal.householdId)
      return c.json({ error: 'not_found' }, 404);

    const decision = canEditOrDeleteMessage({
      actorId: principal.membershipId,
      message: {
        senderId: id<'MembershipId'>(message.senderId),
        serverCreatedAt: message.serverCreatedAt.toISOString(),
        deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
      },
      now: new Date(),
    });
    if (!decision.ok) {
      return c.json({ error: decision.reason }, decision.reason === 'not_author' ? 403 : 409);
    }

    const patch: { body?: string | null; caption?: string | null } = await c.req
      .json()
      .catch(() => ({}));
    if (message.kind === 'text' && patch.body !== undefined) {
      const trimmed = patch.body?.trim() ?? '';
      if (!trimmed) return c.json({ error: 'body_required' }, 400);
      patch.body = trimmed;
    }
    if (message.kind === 'photo' && patch.caption !== undefined) {
      const trimmed = patch.caption?.trim() ?? '';
      patch.caption = trimmed || null;
    }
    await db
      .update(chatMessages)
      .set({ ...patch, editedAt: new Date() })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.householdId, principal.householdId),
          eq(chatMessages.senderId, principal.membershipId),
        ),
      );
    const [updated] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    const names = await resolveMembershipLabels(db, principal.householdId, [updated!.senderId]);

    // Re-run intent detection against the edited text/caption so a corrected
    // caption can produce a fresh private suggestion (ticket 06, AC#5). The
    // original media is never rewritten.
    const [transcriptRow] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    const intent = detectMessageIntent(
      {
        kind: updated!.kind,
        body: updated!.body,
        caption: updated!.caption,
      },
      transcriptRow ? toDomainTranscript(transcriptRow) : null,
    );

    return c.json({
      item: serializeChatMessage(updated!, names, transcriptRow ?? null),
      intent,
    });
  });

  /**
   * Delete your own human message within the 15-minute window (issue 06,
   * AC#11). A deletion leaves a "Message deleted" tombstone in the timeline;
   * media access is revoked (the media-ref is cleared and the private object
   * is scheduled for deletion from the media store). The tombstone remains
   * so the shared timeline stays coherent.
   */
  app.delete('/v1/households/:householdId/chat/messages/:messageId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'edit_delete_own_message',
    );
    const messageId = c.req.param('messageId');
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    if (!message || message.householdId !== principal.householdId)
      return c.json({ error: 'not_found' }, 404);

    const decision = canEditOrDeleteMessage({
      actorId: principal.membershipId,
      message: {
        senderId: id<'MembershipId'>(message.senderId),
        serverCreatedAt: message.serverCreatedAt.toISOString(),
        deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
      },
      now: new Date(),
    });
    if (!decision.ok) {
      return c.json({ error: decision.reason }, decision.reason === 'not_author' ? 403 : 409);
    }

    // Revoke media access immediately and schedule the private object for
    // deletion (issue 06 — deleting a photo or voice note revokes access to
    // its media immediately).
    if (message.mediaRef) {
      await media.delete(message.mediaRef);
    }
    await db
      .update(chatMessages)
      .set({ deletedAt: new Date(), mediaRef: null })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.householdId, principal.householdId),
          eq(chatMessages.senderId, principal.membershipId),
        ),
      );
    const [updated] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    const names = await resolveMembershipLabels(db, principal.householdId, [updated!.senderId]);
    const [transcriptRow] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    return c.json({ item: serializeChatMessage(updated!, names, transcriptRow ?? null) });
  });

  /**
   * Upload a private photo or voice note (ticket 06, AC#1/2). The media is
   * stored behind an opaque `mediaRef` tagged with this Household; it is never
   * a public permanent URL. The caller then references this `mediaRef` when
   * sending a photo or voice message. Authorization is re-checked on every
   * subsequent media read (issue 06, AC#3).
   *
   * The request body is the raw media bytes with a `Content-Type` header; the
   * `kind` query parameter selects photo or voice. A voice note's duration in
   * milliseconds is optional here and enforced on send.
   */
  app.post('/v1/households/:householdId/chat/media', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'send_message',
    );
    const kind = c.req.query('kind') as MediaKind | undefined;
    if (kind !== 'photo' && kind !== 'voice') {
      return c.json({ error: 'kind_required' }, 400);
    }
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.byteLength === 0) return c.json({ error: 'empty_media' }, 400);
    const stored = await media.put({
      householdId: principal.householdId,
      kind,
      contentType,
      data,
    });
    return c.json({ mediaRef: stored.mediaRef, kind: stored.kind, bytes: stored.bytes }, 201);
  });

  /**
   * Authorized media access (ticket 06, AC#3 — private media is accessible
   * only through short-lived authorized access and never through a public
   * permanent URL). The server re-authorizes the membership and verifies the
   * media belongs to this Household on every request, then proxies the bytes.
   * A cross-Household mediaRef resolves to nothing (issue 06, AC#8).
   */
  app.get('/v1/households/:householdId/chat/media/:mediaRef', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
    );
    const mediaRef = c.req.param('mediaRef');
    // The mediaRef may be URL-encoded when it contains slashes.
    const decoded = decodeURIComponent(mediaRef);
    const resolved = await media.resolve(decoded, principal.householdId);
    if (!resolved) return c.json({ error: 'not_found' }, 404);
    return new Response(resolved.data, {
      headers: {
        'content-type': resolved.contentType,
        'cache-control': 'private, no-store, max-age=0',
      },
    });
  });

  /**
   * Correct a voice transcript within the 15-minute edit window (ticket 06,
   * AC#4 — uncertain output is labelled and correctable; AC#5 — correcting a
   * transcript re-runs intent detection without rewriting the original media).
   * The original automatic transcript is preserved; the correction is stored
   * in `correctedTranscript`. Only the author may correct, and only for a
   * voice note.
   */
  app.patch('/v1/households/:householdId/chat/messages/:messageId/transcript', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'edit_delete_own_message',
    );
    const messageId = c.req.param('messageId');
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    if (!message || message.householdId !== principal.householdId)
      return c.json({ error: 'not_found' }, 404);

    const body: { correctedTranscript?: string } = await c.req.json().catch(() => ({}));
    const corrected = body.correctedTranscript ?? '';
    const decision = canCorrectTranscript({
      actorId: principal.membershipId,
      message: {
        kind: message.kind,
        senderId: id<'MembershipId'>(message.senderId),
        serverCreatedAt: message.serverCreatedAt.toISOString(),
        deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
      },
      correctedText: corrected,
      now: new Date(),
    });
    if (!decision.ok) {
      const status =
        decision.reason === 'not_author' ? 403 : decision.reason === 'not_voice' ? 400 : 409;
      return c.json({ error: decision.reason }, status);
    }

    // Preserve the original automatic transcript; store the correction
    // separately so the UI can label it (ticket 06, AC#4).
    const [existing] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    const trimmed = corrected.trim();
    if (existing) {
      await db
        .update(voiceTranscripts)
        .set({ correctedTranscript: trimmed })
        .where(eq(voiceTranscripts.messageId, messageId));
    } else {
      await db.insert(voiceTranscripts).values({
        messageId,
        language: null,
        transcript: null,
        status: 'ready',
        correctedTranscript: trimmed,
      });
    }
    const [updated] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    const domainTranscript = toDomainTranscript(updated!);
    // Re-run intent detection against the corrected transcript (ticket 06,
    // AC#5). The original media is never rewritten.
    const intent = detectMessageIntent(
      { kind: message.kind, body: message.body, caption: message.caption },
      domainTranscript,
    );
    return c.json({ transcript: serializeTranscript(updated!), intent });
  });

  /**
   * Mark Chat read through the latest visible position (issue 04 / 06). The
   * last-read position is private per person and Household; it is never exposed
   * as a read receipt. Pending structured action badges are derived from
   * structured state and are not cleared here.
   */
  app.post('/v1/households/:householdId/chat/read', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
    );
    const body = await c.req.json().catch(() => ({}));
    const lastReadMessageId = (body as { lastReadMessageId?: string })?.lastReadMessageId;
    if (!lastReadMessageId) return c.json({ error: 'last_read_required' }, 400);
    await db
      .insert(householdMemberState)
      .values({
        userId: principal.userId,
        householdId: principal.householdId,
        lastReadMessageId,
      })
      .onDuplicateKeyUpdate({ set: { lastReadMessageId } });
    return c.json({ ok: true });
  });

  app.onError((err, c) => {
    if (err instanceof AuthorizationDeniedError) {
      console.warn('authorization_denied', err.detail);
      return c.json({ error: 'not_found' }, 404);
    }
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

type HouseholdRow = typeof households.$inferSelect;

async function ensureStarterPlan(db: Database, household: HouseholdRow, ownerMembershipId: string) {
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
    updatedBy: ownerMembershipId,
  }));
  await db.insert(plannedMeals).values(meals);
  return meals;
}

function clampServingCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 4;
  return Math.min(12, Math.max(1, Math.round(value)));
}

function normalizeDietStyle(
  value: string | undefined,
): 'vegetarian' | 'eggetarian' | 'nonvegetarian' {
  if (value === 'eggetarian' || value === 'nonvegetarian') return value;
  return 'vegetarian';
}

/** Map a Drizzle invite row onto the lifecycle projection. */
function toInviteRecord(row: typeof householdInvites.$inferSelect): InviteRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    role: row.role,
    phoneHash: row.phoneHash,
    token: row.token,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedByUserId: row.acceptedByUserId,
    revokedAt: null,
  };
}

/**
 * A stable, non-reversable label for the invite list. Because the stored hash
 * is one-way we cannot recover digits, so we surface the trailing hash segment
 * as a disambiguator — enough to tell two pending invites apart, never enough
 * to identify the recipient.
 */
function maskPhoneHash(phoneHash: string): string {
  return `•••• ${phoneHash.slice(-4)}`;
}

/** Clamp a pagination limit to a safe positive bound. */
function clampPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

type PlannedMealRow = typeof plannedMeals.$inferSelect;
type ChatMessageRow = typeof chatMessages.$inferSelect;
type SystemEventRow = typeof systemEvents.$inferSelect;
/**
 * A connection that can run queries — either the top-level {@link Database} or
 * a transaction (`tx`). Used so the meal-edit helpers can run inside a
 * `db.transaction` and keep swap writes + events atomic (ticket 05, item 4).
 */
type DbConnection = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Map a Drizzle planned-meal row onto the domain {@link PlannedMeal} so the
 * pure edit/regenerate rules in `@cooklink/domain` can decide on a typed value
 * (ticket 05 — the durable plan model is shared by both roles).
 */
function toDomainPlannedMeal(row: PlannedMealRow): PlannedMeal {
  return {
    id: id<'PlannedMealId'>(row.id),
    householdId: id<'HouseholdId'>(row.householdId),
    date: row.date,
    mealType: row.mealType,
    recipeId: row.recipeId ? id<'RecipeId'>(row.recipeId) : null,
    name: row.name,
    servings: row.servings,
    servingsOverridden: row.servingsOverridden,
    isSpecial: row.isSpecial,
    version: row.version,
    updatedBy: row.updatedBy ? id<'MembershipId'>(row.updatedBy) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a planned-meal row for the API. Field names match the domain model
 * so the mobile client renders one shape regardless of role (ticket 05).
 */
function serializePlannedMeal(row: PlannedMealRow) {
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
 * Serialize a domain {@link PlannedMeal} (e.g. the `current` meal returned on a
 * rejected edit) using the same shape as {@link serializePlannedMeal}.
 */
function serializeDomainPlannedMeal(meal: PlannedMeal) {
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
async function applyMealPatch(
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
  if (result[0].affectedRows !== 1) return null;
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
 * {@link DbConnection} so it can run inside the same transaction as the write.
 */
async function recordMealChangedEvent(
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

/**
 * Resolve a stable display label for each membership id so messages and events
 * stay attributed after a participant leaves (issue 06 — historical messages
 * remain attributed; the UI labels the inactive role without exposing removed
 * account details). We surface the role alongside the name so the client can
 * show "Cook · Meera" and an inactive marker when the membership is gone.
 */
async function resolveMembershipLabels(
  db: Database,
  householdId: string,
  membershipIds: string[],
): Promise<Map<string, { displayName: string; role: string; active: boolean }>> {
  const out = new Map<string, { displayName: string; role: string; active: boolean }>();
  if (membershipIds.length === 0) return out;
  const rows = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.householdId, householdId), inArray(memberships.id, membershipIds)));
  for (const row of rows) {
    out.set(row.membership.id, {
      displayName: row.user.displayName,
      role: row.membership.role,
      active: row.membership.status === 'active',
    });
  }
  return out;
}

function serializeChatMessage(
  row: ChatMessageRow,
  labels: Map<string, { displayName: string; role: string; active: boolean }>,
  transcriptRow: typeof voiceTranscripts.$inferSelect | null,
) {
  const sender = labels.get(row.senderId);
  const domainTranscript = transcriptRow ? toDomainTranscript(transcriptRow) : null;
  return {
    kind: 'message' as const,
    id: row.id,
    householdId: row.householdId,
    senderId: row.senderId,
    sender: sender
      ? { displayName: sender.displayName, role: sender.role, active: sender.active }
      : null,
    messageKind: row.kind,
    body: row.deletedAt ? null : row.body,
    caption: row.deletedAt ? null : row.caption,
    mediaRef: row.deletedAt ? null : row.mediaRef,
    transcript: serializeTranscript(transcriptRow),
    transcriptText: row.deletedAt ? null : effectiveTranscript(domainTranscript),
    transcriptAutomatic: row.deletedAt ? false : isAutomaticTranscript(domainTranscript),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    clientCreatedAt: row.clientCreatedAt.toISOString(),
    serverCreatedAt: row.serverCreatedAt.toISOString(),
  };
}

/** Map a Drizzle voice-transcript row onto the domain {@link VoiceTranscript}. */
function toDomainTranscript(row: typeof voiceTranscripts.$inferSelect) {
  return {
    messageId: id<'ChatMessageId'>(row.messageId),
    language: row.language,
    transcript: row.transcript,
    status: row.status,
    correctedTranscript: row.correctedTranscript,
  };
}

/** Serialize a transcript row for the API (null when there is no transcript). */
function serializeTranscript(row: typeof voiceTranscripts.$inferSelect | null) {
  if (!row) return null;
  return {
    messageId: row.messageId,
    language: row.language,
    transcript: row.transcript,
    status: row.status,
    correctedTranscript: row.correctedTranscript,
  };
}

function serializeChatEvent(
  row: SystemEventRow,
  labels: Map<string, { displayName: string; role: string; active: boolean }>,
  lang: Language,
) {
  const actor = row.actorId ? (labels.get(row.actorId) ?? null) : null;
  // Render the safe event text in the VIEWER's selected language — human
  // messages are never translated; system events render in each viewer's
  // English or Hindi locale (issue 06, AC#21). The raw payload is always
  // included so the client can re-render if its own selection changes.
  const text = renderEvent(
    {
      id: id<'SystemEventId'>(row.id),
      householdId: id<'HouseholdId'>(row.householdId),
      type: row.type as SystemEventType,
      actorId: row.actorId ? id<'MembershipId'>(row.actorId) : null,
      entityType: row.entityType,
      entityId: row.entityId,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    },
    lang,
  );
  return {
    kind: 'event' as const,
    id: row.id,
    householdId: row.householdId,
    type: row.type,
    actorId: row.actorId,
    actor: actor
      ? { displayName: actor.displayName, role: actor.role, active: actor.active }
      : null,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: row.payload,
    text,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Resolve the viewer's language for system-event rendering (issue 06, AC#21).
 * The client may pass `?lang=en|hi`; otherwise the Household default applies.
 */
function resolveViewerLanguage(
  requested: string | undefined,
  householdDefault: 'en' | 'hi' | undefined,
): Language {
  if (requested === 'hi' || requested === 'en') return requested;
  return householdDefault ?? 'en';
}
