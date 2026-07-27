import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMembershipRemoval } from '../membership-lifecycle.js';

const base = {
  actorMembershipId: 'owner-1',
  targetMembershipId: 'cook-1',
  targetStatus: 'active',
  targetRole: 'cook' as const,
};

test('an owner may remove an active member or cook', () => {
  assert.equal(validateMembershipRemoval(base), null);
  assert.equal(validateMembershipRemoval({ ...base, targetRole: 'member' }), null);
});

test('an owner cannot remove themselves', () => {
  assert.equal(
    validateMembershipRemoval({ ...base, targetMembershipId: 'owner-1' }),
    'cannot_remove_self',
  );
});

test('removing an already-removed membership is a no-op', () => {
  assert.equal(validateMembershipRemoval({ ...base, targetStatus: 'removed' }), 'already_removed');
});
