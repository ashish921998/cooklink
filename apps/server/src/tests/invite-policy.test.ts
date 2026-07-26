import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPhone, normalizePhone, validateInviteAcceptance } from '../invite-policy.js';

const valid = {
  invitedPhoneHash: hashPhone('+91 90000 00000'),
  verifiedPhone: '+919000000000',
  hasActiveHouseholdRole: false,
  role: 'cook' as const,
  activeHouseholdCooks: 1,
  activeCookHouseholds: 29,
};

test('phone formatting is normalized consistently', () => {
  assert.equal(normalizePhone('+91 90000-00000'), '+919000000000');
  assert.equal(hashPhone('+91 90000-00000'), hashPhone('+919000000000'));
});

test('matching verified phone can accept within cook limits', () => {
  assert.equal(validateInviteAcceptance(valid), null);
});

test('a different verified phone cannot accept an invite', () => {
  assert.equal(
    validateInviteAcceptance({ ...valid, verifiedPhone: '+919999999999' }),
    'invite_phone_mismatch',
  );
});

test('one active role per household is enforced', () => {
  assert.equal(
    validateInviteAcceptance({ ...valid, hasActiveHouseholdRole: true }),
    'household_role_already_exists',
  );
});

test('cook limits are enforced', () => {
  assert.equal(
    validateInviteAcceptance({ ...valid, activeHouseholdCooks: 2 }),
    'household_cook_limit_reached',
  );
  assert.equal(
    validateInviteAcceptance({ ...valid, activeCookHouseholds: 30 }),
    'cook_household_limit_reached',
  );
});
