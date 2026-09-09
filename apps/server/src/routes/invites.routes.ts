/**
 * Household Invite API routes (issue 03).
 *
 * An invite is a phone-bound, role-specific, single-use link shared by the
 * Household Owner: create, list (masked phone), revoke, resend (fresh token),
 * and accept. Acceptance verifies the phone hash, enforces the Cook limits
 * (two active Cooks per Household, thirty active Households per Cook), and
 * serializes concurrent acceptances with the invite-status update as the
 * primary lock.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, count, desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { brandId } from '@cooklink/domain';
import { householdInvites, households, memberships, systemEvents, users } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { hashPhone, validateInviteAcceptance } from '../invite-policy.js';
import {
  INVITE_TTL_MS,
  acceptStatusFor,
  isInviteResendable,
  isInviteRevocable,
  type InviteRecord,
} from '../invite-lifecycle.js';
import type { AppRouteContext } from './route-context.js';

type HouseholdRoleInvite = 'member' | 'cook';

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). The `pg`
 * driver attaches `code` to errors; fall back to a message match for safety.
 */
function isUniqueViolation(err: Error): boolean {
  const code = (err as { code?: string }).code;
  if (code === '23505') return true;
  return /duplicate key/i.test(err.message);
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

/** Mount the household-invite routes: create, list, revoke, resend, accept. */
export function registerInviteRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization } = ctx;

  app.post('/v1/households/:householdId/invites', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
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
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
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
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(invite.householdId),
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
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(invite.householdId),
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
        // acceptance of the same invite can proceed (rowCount !== 1).
        const result = await tx
          .update(householdInvites)
          .set({ status: 'accepted', acceptedByUserId: user.id })
          .where(and(eq(householdInvites.id, invite.id), eq(householdInvites.status, 'pending')));
        if (result.rowCount !== 1) {
          throw new InviteAlreadyConsumedError();
        }

        // Serialize the Cook-limit checks that the single-use invite lock
        // cannot reach: two different cook invites into the same household,
        // or one cook accepting into several households at once. Locking the
        // household row serializes the per-household two-Cook budget; locking
        // the accepting user's row serializes the per-Cook 30-Household
        // budget. The locks are acquired in a fixed order (household then
        // user) so the lock graph stays acyclic, and every acceptance path
        // takes both, so any two acceptances touching the same household or
        // the same user commit one after the other. With both held, the
        // count re-checks below see a stable view — no other acceptance for
        // this household or this user can commit until this transaction ends
        // (issue 03 — serialize Cook-limit enforcement safely).
        await tx
          .select({ id: households.id })
          .from(households)
          .where(eq(households.id, invite.householdId))
          .for('update')
          .limit(1);
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, user.id))
          .for('update')
          .limit(1);

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
      // A unique-constraint violation from the unique index on (userId,
      // householdId, status) means a concurrent acceptance already created
      // the active membership — surface it as a conflict, not a 500.
      if (err instanceof Error && isUniqueViolation(err)) {
        return c.json({ error: 'already_member' }, 409);
      }
      throw err;
    }

    return c.json({ householdId: invite.householdId, role: invite.role });
  });
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
