import { hashPhone } from './invite-policy.js';

/**
 * The Household Invite lifecycle (issue 03 — invitations).
 *
 * An invite is phone-bound, role-specific, single-use, revocable, and expires
 * after seven days. This module is the pure, database-agnostic half of that
 * contract: the Hono handlers in `app.ts` load a row, hand it here for a
 * verdict, and then persist the resulting status. Keeping the rules out of the
 * request path lets the lifecycle be unit-tested without Postgres.
 */

/** A Household Invite lasts seven days (spec — first use and invitations). */
export const INVITE_TTL_DAYS = 7;
export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * The lifecycle-relevant projection of a `household_invites` row. The server
 * maps its Drizzle row onto this shape so the rules never touch the ORM.
 */
export interface InviteRecord {
  id: string;
  householdId: string;
  role: 'member' | 'cook';
  phoneHash: string;
  token: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  acceptedByUserId: string | null;
  revokedAt: string | null;
}

/**
 * A pending, unexpired invite may still be acted on by its owner — revoked or
 * resent (issue 03). Household scoping is already enforced upstream by
 * `authorizeCapability('manage_membership')`, so this predicate only answers
 * "is the invite itself still in play".
 */
export function isInviteMutable(invite: InviteRecord): boolean {
  return invite.status === 'pending' && !isInviteExpired(invite);
}

/** Alias kept for call-site readability at the revoke and resend handlers. */
export const isInviteRevocable = isInviteMutable;
export const isInviteResendable = isInviteMutable;

/** Has this invite already done its single-use job or been taken out of play? */
export function isInviteConsumed(invite: InviteRecord): boolean {
  return invite.status === 'accepted' || invite.status === 'revoked';
}

export function isInviteExpired(
  invite: InviteRecord,
  now: string = new Date().toISOString(),
): boolean {
  return new Date(invite.expiresAt).getTime() <= new Date(now).getTime();
}

export interface AcceptanceClock {
  verifiedPhone: string;
  now: string;
}

export type AcceptanceStatus = { ok: true } | { ok: false; error: AcceptanceError };

export type AcceptanceError = 'invite_invalid' | 'invite_consumed' | 'invite_phone_mismatch';

/**
 * Resolve whether an invite may be accepted by a verified phone, before the
 * household/cook budget checks in {@link validateInviteAcceptance}. This
 * centralizes "is the invite itself still good" so the handler can return one
 * of the plain-English errors the client surfaces.
 */
export function acceptStatusFor(invite: InviteRecord, clock: AcceptanceClock): AcceptanceStatus {
  if (invite.status !== 'pending') return { ok: false, error: 'invite_consumed' };
  if (isInviteExpired(invite, clock.now)) return { ok: false, error: 'invite_invalid' };
  if (invite.phoneHash !== hashPhone(clock.verifiedPhone)) {
    return { ok: false, error: 'invite_phone_mismatch' };
  }
  return { ok: true };
}
