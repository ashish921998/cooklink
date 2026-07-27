import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import {
  Authorization,
  AuthorizationDeniedError,
  generateStarterPlan,
  id,
  todayISO,
} from '@cooklink/domain';
import { householdInvites, households, memberships, plannedMeals, systemEvents } from '@cooklink/db';
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

type HouseholdRoleInvite = 'member' | 'cook';

export function createApp(db: Database) {
  const app = new Hono<AuthEnv>();
  const authorization = new Authorization(new DrizzleAuthorizationLookup(db));

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
    await authorization.authorizeCapability(
      id<'UserId'>(user.id),
      id<'HouseholdId'>(householdId),
      'read_chat',
    );
    const meals = await db
      .select()
      .from(plannedMeals)
      .where(eq(plannedMeals.householdId, householdId))
      .orderBy(asc(plannedMeals.date), asc(plannedMeals.mealType));
    return c.json({ meals });
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
    const [existingHome] = await db
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
      .limit(1);
    if (existingHome) {
      const existingMeals = await ensureStarterPlan(
        db,
        existingHome.household,
        existingHome.ownerMembershipId,
      );
      return c.json({
        householdId: existingHome.household.id,
        planStart: existingMeals[0]?.date ?? todayISO(),
        mealCount: existingMeals.length,
        resumed: true,
      });
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
    await db.transaction(async (tx) => {
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
    });
    return c.json({ householdId, planStart, mealCount: meals.length }, 201);
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
    return c.json({ id: inviteId, token, role: body.role, expiresAt: expiresAt.toISOString() }, 201);
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
        and(
          eq(householdInvites.householdId, householdId),
          eq(householdInvites.status, 'pending'),
        ),
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
    await db.transaction(async (tx) => {
      const result = await tx
        .update(householdInvites)
        .set({ status: 'accepted', acceptedByUserId: user.id })
        .where(and(eq(householdInvites.id, invite.id), eq(householdInvites.status, 'pending')));
      if (result[0].affectedRows !== 1) {
        throw new Error('invite_already_consumed');
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
      return c.json({ ok: true, role: principal.role, householdId });
    } catch {
      return c.json({ ok: false }, 403);
    }
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
