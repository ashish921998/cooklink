import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Authorization,
  AuthorizationDeniedError,
  InMemoryRepository,
  id,
  capabilities,
} from '../index.js';

async function setup() {
  const repo = new InMemoryRepository();
  const auth = new Authorization(repo);
  const user = await repo.createUser({
    id: id<'UserId'>('u-owner'),
    clerkUserId: 'clerk-1',
    phone: '+919999999999',
    displayName: 'Owner',
  });
  const { household, ownerMembership } = await repo.createHousehold(
    {
      name: 'Sharma Home',
      photoUrl: null,
      servingCount: 4,
      mealStyle: 'north',
      dietStyle: 'vegetarian',
      healthEmphasis: [],
      specialMealEnabled: false,
      defaultLanguage: 'en',
    },
    user.id,
  );
  return { repo, auth, user, household, ownerMembership };
}

test('authorize succeeds for an active owner', async () => {
  const { auth, user, household } = await setup();
  const principal = await auth.authorize(user.id, household.id);
  assert.equal(principal.role, 'owner');
  assert.equal(principal.householdId, household.id);
});

test('authorize denies a non-member', async () => {
  const { auth, household } = await setup();
  const stranger = id<'UserId'>('u-stranger');
  await assert.rejects(
    () => auth.authorize(stranger, household.id),
    (e: unknown) => e instanceof AuthorizationDeniedError,
  );
});

test('authorize denies a removed member immediately (access changed)', async () => {
  const { repo, auth, household } = await setup();
  const cook = await repo.createUser({
    id: id<'UserId'>('u-cook'),
    clerkUserId: 'c-2',
    phone: '+918888888888',
    displayName: 'Cook',
  });
  const m = await repo.addMembership(household.id, cook.id, 'cook');
  // active cook can authorize
  await auth.authorize(cook.id, household.id);
  await repo.removeMembership(m.id);
  await assert.rejects(() => auth.authorize(cook.id, household.id), AuthorizationDeniedError);
});

test('authorize denies when the household is closed', async () => {
  const { repo, auth, user, household } = await setup();
  // simulate closure
  repo.households.set(household.id as string, { ...household, closedAt: new Date().toISOString() });
  await assert.rejects(() => auth.authorize(user.id, household.id), AuthorizationDeniedError);
});

test('capability matrix: cook can create requests but cannot approve or checkout', async () => {
  const { repo, auth, user, household } = await setup();
  const cookUser = await repo.createUser({
    id: id<'UserId'>('u-cook2'),
    clerkUserId: 'c-3',
    phone: '+917777777777',
    displayName: 'Cook',
  });
  await repo.addMembership(household.id, cookUser.id, 'cook');
  const cookPrincipal = await auth.authorize(cookUser.id, household.id);
  assert.equal(capabilities.canCreateGroceryRequest(cookPrincipal.role), true);
  assert.equal(capabilities.canApproveRejectRequest(cookPrincipal.role), false);
  assert.equal(capabilities.canManageCart(cookPrincipal.role), false);
  assert.equal(capabilities.canCheckout(cookPrincipal.role), false);

  const memberPrincipal = await auth.authorize(user.id, household.id); // owner acts like member-side
  // owner can approve/checkout/manage membership
  assert.equal(capabilities.canApproveRejectRequest(memberPrincipal.role), true);
  assert.equal(capabilities.canCheckout(memberPrincipal.role), true);
  assert.equal(capabilities.canManageMembership(memberPrincipal.role), true);
  // but an owner/member cannot create a grocery request (only cooks can)
  assert.equal(capabilities.canCreateGroceryRequest(memberPrincipal.role), false);
});

test('authorizeCapability enforces a capability and denies otherwise', async () => {
  const { repo, auth, household } = await setup();
  const cookUser = await repo.createUser({
    id: id<'UserId'>('u-cook3'),
    clerkUserId: 'c-4',
    phone: '+916666666666',
    displayName: 'Cook',
  });
  await repo.addMembership(household.id, cookUser.id, 'cook');
  await auth.authorizeCapability(cookUser.id, household.id, 'create_grocery_request');
  await assert.rejects(
    () => auth.authorizeCapability(cookUser.id, household.id, 'review_place_order'),
    AuthorizationDeniedError,
  );
});
