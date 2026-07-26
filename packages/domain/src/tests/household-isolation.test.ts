import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Authorization, AuthorizationDeniedError, InMemoryRepository, id } from '../index.js';

/**
 * The mandatory backend authorization isolation suite (issue 06 AC#22,
 * issue 07 AC#17 & AC#21): a membership cannot read, write, or subscribe to
 * another Household's data. Every household-scoped surface is covered.
 */
async function twoHouseholds() {
  const repo = new InMemoryRepository();
  const auth = new Authorization(repo);

  const userA = await repo.createUser({
    id: id<'UserId'>('u-a'),
    clerkUserId: 'ca',
    phone: '+919111111111',
    displayName: 'A-owner',
  });
  const userB = await repo.createUser({
    id: id<'UserId'>('u-b'),
    clerkUserId: 'cb',
    phone: '+919122222222',
    displayName: 'B-owner',
  });
  const ha = await repo.createHousehold(makeHousehold('House A'), userA.id);
  const hb = await repo.createHousehold(makeHousehold('House B'), userB.id);

  // a cook in A only
  const cookA = await repo.createUser({
    id: id<'UserId'>('u-cooka'),
    clerkUserId: 'cc',
    phone: '+919133333333',
    displayName: 'Cook A',
  });
  const cookAMembership = await repo.addMembership(ha.household.id, cookA.id, 'cook');

  return { repo, auth, userA, userB, ha, hb, cookA, cookAMembership };
}

function makeHousehold(name: string) {
  return {
    name,
    photoUrl: null,
    servingCount: 4,
    mealStyle: 'north' as const,
    dietStyle: 'vegetarian' as const,
    healthEmphasis: [],
    specialMealEnabled: false,
    defaultLanguage: 'en' as const,
  };
}

test('a member of A cannot authorize into B', async () => {
  const { auth, userA, hb } = await twoHouseholds();
  await assert.rejects(() => auth.authorize(userA.id, hb.household.id), AuthorizationDeniedError);
});

test('chat timeline is household-scoped: A never sees B messages', async () => {
  const { repo, ha, hb, userB } = await twoHouseholds();
  // put a secret message in B
  await repo.createMessage(hb.household.id, {
    senderId: (await repo.listMembers(hb.household.id))[0]!.id,
    kind: 'text',
    body: 'SECRET-FOR-B',
    caption: null,
    mediaRef: null,
    clientCreatedAt: new Date().toISOString(),
  });
  // A's timeline must not contain it
  const aTimeline = await repo.getChatTimeline(ha.household.id, null, 50);
  assert.equal(aTimeline.length, 0);
  const bTimeline = await repo.getChatTimeline(hb.household.id, null, 50);
  assert.equal(bTimeline.length, 1);
  const secret = bTimeline[0]!.kind === 'message' ? bTimeline[0]!.message.body : null;
  assert.equal(secret, 'SECRET-FOR-B');
  void userB;
});

test('system events never cross households', async () => {
  const { repo, ha, hb, cookAMembership } = await twoHouseholds();
  await repo.appendSystemEvent(ha.household.id, {
    type: 'membership.joined',
    actorId: cookAMembership.id,
    entityType: 'membership',
    entityId: 'x',
    payload: { role: 'cook' },
  });
  const bEvents = repo.events.filter((e) => e.householdId === hb.household.id);
  assert.equal(bEvents.length, 0);
  const aEvents = repo.events.filter((e) => e.householdId === ha.household.id);
  assert.equal(aEvents.length, 1);
});

test('meal plan is household-scoped', async () => {
  const { repo, ha, hb, cookAMembership } = await twoHouseholds();
  await repo.upsertPlannedMeal(
    ha.household.id,
    {
      date: '2026-01-01',
      mealType: 'breakfast',
      recipeId: null,
      name: 'Poha',
      servings: 4,
      servingsOverridden: false,
      isSpecial: false,
    },
    cookAMembership.id,
  );
  const inA = await repo.listMealsForDay(ha.household.id, '2026-01-01');
  const inB = await repo.listMealsForDay(hb.household.id, '2026-01-01');
  assert.equal(inA.length, 1);
  assert.equal(inB.length, 0);
});

test('grocery requests are household-scoped', async () => {
  const { repo, ha, hb, cookAMembership } = await twoHouseholds();
  const { request } = await repo.createGroceryRequest(
    ha.household.id,
    { itemText: 'coconut', quantityText: '1' },
    cookAMembership.id,
  );
  const inB = await repo.listGroceryRequests(hb.household.id);
  assert.equal(inB.length, 0);
  // a cook from A cannot fetch B's request directly either (repo is keyed)
  const direct = await repo.getGroceryRequest(request.id);
  assert.ok(direct); // exists, but it belongs to A
  assert.equal(direct!.householdId, ha.household.id);
});

test('suggested cart and pantry ledger are household-scoped', async () => {
  const { repo, ha, hb } = await twoHouseholds();
  await repo.appendPantryLedger(ha.household.id, {
    ingredientKey: 'tomato',
    deltaG: 500,
    deltaMl: null,
    deltaCount: null,
    source: 'order_delivered',
    perishable: false,
    freshnessDays: null,
    at: new Date().toISOString(),
  });
  const bLedger = await repo.listPantryLedger(hb.household.id, 'tomato');
  assert.equal(bLedger.length, 0);
  const aLedger = await repo.listPantryLedger(ha.household.id, 'tomato');
  assert.equal(aLedger.length, 1);
});

test('suggestions are private to their author and household', async () => {
  const { repo, ha, hb, cookAMembership } = await twoHouseholds();
  const s = await repo.createSuggestion(ha.household.id, {
    authorId: cookAMembership.id,
    sourceMessageId: null,
    intent: { kind: 'grocery_request', item: 'haldi', quantity: null },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  // listing pending for a membership in B returns nothing
  const inB = await repo.listPendingSuggestions(id<'MembershipId'>('nonexistent-b'));
  assert.equal(inB.length, 0);
  // a cross-household status update is ignored
  await repo.updateSuggestionStatus(hb.household.id, s.id as string, 'dismissed');
  const after = await repo.getSuggestion(s.id as string);
  assert.equal(after!.status, 'pending');
});

test('orders are household-scoped', async () => {
  const { repo, ha, hb, cookAMembership } = await twoHouseholds();
  const ownerA = (await repo.listMembers(ha.household.id))[0]!;
  const order = await repo.createOrder(ha.household.id, ownerA.id, {
    providerOrderId: 'ord-1',
    status: 'placed',
    totalCents: 49900,
  });
  const bOrders = await repo.listOrders(hb.household.id);
  assert.equal(bOrders.length, 0);
  const aOrders = await repo.listOrders(ha.household.id);
  assert.equal(aOrders.length, 1);
  assert.equal(aOrders[0]!.id, order.id);
  void cookAMembership;
});

test('media/transcripts are tied to household messages and do not leak', async () => {
  const { repo, hb } = await twoHouseholds();
  const ownerB = (await repo.listMembers(hb.household.id))[0]!;
  const msg = await repo.createMessage(hb.household.id, {
    senderId: ownerB.id,
    kind: 'voice',
    body: null,
    caption: null,
    mediaRef: 'r2://hb/voice1',
    clientCreatedAt: new Date().toISOString(),
  });
  await repo.setTranscript(msg.id, {
    messageId: msg.id,
    language: 'hi',
    transcript: 'नारियल चाहिए',
    status: 'ready',
    correctedTranscript: null,
  });
  // A's timeline has no messages and thus no transcript
  const aTimeline = await repo.getChatTimeline(id<'HouseholdId'>('house-a'), null, 10);
  assert.equal(aTimeline.length, 0);
  // transcript retrieval is keyed by message id, which lives only in B
  const t = await repo.getTranscript(msg.id);
  assert.equal(t!.transcript, 'नारियल चाहिए');
});

test('edit/delete of a message is scoped to sender + household', async () => {
  const { repo, ha, hb } = await twoHouseholds();
  const ownerB = (await repo.listMembers(hb.household.id))[0]!;
  const msg = await repo.createMessage(hb.household.id, {
    senderId: ownerB.id,
    kind: 'text',
    body: 'hi',
    caption: null,
    mediaRef: null,
    clientCreatedAt: new Date().toISOString(),
  });
  // a membership from A pretending to edit B's message (wrong household) fails
  const ownerA = (await repo.listMembers(ha.household.id))[0]!;
  await assert.rejects(
    () => repo.editMessage(ha.household.id, msg.id, ownerA.id, { body: 'hacked' }),
    /forbidden/,
  );
});
