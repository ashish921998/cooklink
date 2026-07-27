import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPhone } from '../invite-policy.js';
import {
  INVITE_TTL_DAYS,
  acceptStatusFor,
  isInviteConsumed,
  isInviteExpired,
  isInviteRevocable,
  isInviteResendable,
  type InviteRecord,
} from '../invite-lifecycle.js';

/**
 * A pending invite that is fresh, unbound to any caller, and within the
 * household's two-Cook / 30-Household budget. Each test spreads and overrides
 * only the field it is exercising.
 */
function pendingInvite(overrides: Partial<InviteRecord> = {}): InviteRecord {
  return {
    id: 'invite-1',
    householdId: 'h-1',
    role: 'cook',
    phoneHash: hashPhone('+919000000000'),
    token: 'token-aaa',
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
    acceptedByUserId: null,
    revokedAt: null,
    ...overrides,
  };
}

test('the invite lifetime is seven days', () => {
  assert.equal(INVITE_TTL_DAYS, 7);
});

test('a pending, unexpired invite is neither consumed nor expired', () => {
  const invite = pendingInvite();
  assert.equal(isInviteConsumed(invite), false);
  assert.equal(isInviteExpired(invite), false);
  assert.equal(isInviteRevocable(invite), true);
  assert.equal(isInviteResendable(invite), true);
});

test('an expired invite cannot be accepted and is not resendable', () => {
  const invite = pendingInvite({
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal(isInviteExpired(invite), true);
  assert.equal(isInviteResendable(invite), false);
  assert.equal(isInviteRevocable(invite), false);
});

test('a single-use invite is consumed the moment it is accepted', () => {
  const invite = pendingInvite({
    status: 'accepted',
    acceptedByUserId: 'user-2',
  });
  assert.equal(isInviteConsumed(invite), true);
  assert.equal(isInviteResendable(invite), false);
  assert.equal(isInviteRevocable(invite), false);
});

test('a revoked invite is consumed and cannot be accepted or resent', () => {
  const invite = pendingInvite({ status: 'revoked', revokedAt: '2026-07-02T00:00:00.000Z' });
  assert.equal(isInviteConsumed(invite), true);
  assert.equal(isInviteResendable(invite), false);
  assert.equal(isInviteRevocable(invite), false);
});

test('resending requires a pending, unexpired invite', () => {
  // Household ownership is enforced upstream by authorizeCapability, so the
  // predicate only answers whether the invite itself is still in play.
  assert.equal(isInviteResendable(pendingInvite()), true);
  assert.equal(
    isInviteResendable(pendingInvite({ status: 'accepted', acceptedByUserId: 'u' })),
    false,
  );
});

test('acceptance status resolves to a single verdict across phone, status, and expiry', () => {
  const matched = acceptStatusFor(pendingInvite(), {
    verifiedPhone: '+919000000000',
    now: '2026-07-03T00:00:00.000Z',
  });
  assert.deepEqual(matched, { ok: true });

  const wrongPhone = acceptStatusFor(pendingInvite(), {
    verifiedPhone: '+919999999999',
    now: '2026-07-03T00:00:00.000Z',
  });
  assert.equal(wrongPhone.ok, false);
  assert.equal((wrongPhone as { error: string }).error, 'invite_phone_mismatch');

  const expired = acceptStatusFor(pendingInvite({ expiresAt: '2026-07-02T00:00:00.000Z' }), {
    verifiedPhone: '+919000000000',
    now: '2026-07-03T00:00:00.000Z',
  });
  assert.equal(expired.ok, false);
  assert.equal((expired as { error: string }).error, 'invite_invalid');
});
