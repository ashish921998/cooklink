import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoOrderPlacement,
  conflictActorLabel,
  cookMayMutate,
  decideGrocerySuggestion,
  decideRequestResolution,
  decideRequestUpdate,
  findSimilarPendingRequest,
  groceryFollowUpQuestion,
  memberActionLabels,
  normalizeItemText,
  similarityChoiceLabels,
} from '../grocery-request.js';
import { detectIntent } from '../intent.js';
import { Authorization, InMemoryRepository, id } from '../index.js';
import type { ActionSuggestion, GroceryRequest } from '../types.js';

const now = new Date('2026-07-27T10:00:00Z');
const future = new Date('2026-07-27T11:00:00Z').toISOString();

function pendingSuggestion(
  overrides: Partial<ActionSuggestion> = {},
): Pick<ActionSuggestion, 'status' | 'expiresAt'> {
  return { status: 'pending', expiresAt: future, ...overrides };
}

function makeRequest(overrides: Partial<GroceryRequest> = {}): GroceryRequest {
  return {
    id: 'gr-1' as GroceryRequest['id'],
    householdId: 'h-1' as GroceryRequest['householdId'],
    itemText: 'Tomato',
    quantityText: null,
    status: 'pending',
    createdById: 'm-cook' as GroceryRequest['createdById'],
    createdAt: '2026-07-27T09:00:00Z',
    resolvedById: null,
    resolvedAt: null,
    version: 1,
    ...overrides,
  };
}

// ---- decideGrocerySuggestion ----

test('a cook grocery intent with an item confirms to create_grocery_request', () => {
  const d = decideGrocerySuggestion({
    intent: { kind: 'grocery_request', item: 'नारियल', quantity: null },
    role: 'cook',
    language: 'hi',
    suggestion: pendingSuggestion(),
    now,
  });
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.action, 'create_grocery_request');
    assert.equal(d.item, 'नारियल');
  }
});

test('a member grocery intent confirms to add_to_cart, never a grocery request', () => {
  const d = decideGrocerySuggestion({
    intent: { kind: 'add_to_cart', item: 'Tomato', quantity: '1 kg' },
    role: 'member',
    language: 'en',
    suggestion: pendingSuggestion(),
    now,
  });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.action, 'add_to_cart');
});

test('an owner is treated as a member for grocery intent (add_to_cart)', () => {
  const d = decideGrocerySuggestion({
    intent: { kind: 'grocery_request', item: 'Tomato', quantity: null },
    role: 'owner',
    language: 'en',
    suggestion: pendingSuggestion(),
    now,
  });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.action, 'add_to_cart');
});

test('a grocery intent with no item asks one plain follow-up question, not a form (AC#2)', () => {
  const d = decideGrocerySuggestion({
    intent: { kind: 'grocery_request', item: '', quantity: null },
    role: 'cook',
    language: 'en',
    suggestion: pendingSuggestion(),
    now,
  });
  assert.equal(d.ok, false);
  if (!d.ok && d.reason === 'missing_item') assert.equal(d.followUp, 'What do you need?');
});

test('the follow-up question is in the author language (Hindi)', () => {
  assert.equal(groceryFollowUpQuestion('hi'), 'क्या चाहिए?');
  assert.equal(groceryFollowUpQuestion('en'), 'What do you need?');
});

test('a non-grocery intent does not confirm (AC#3 — only a detected grocery action confirms)', () => {
  const d = decideGrocerySuggestion({
    intent: { kind: 'unknown' },
    role: 'cook',
    language: 'en',
    suggestion: pendingSuggestion(),
    now,
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'unknown_intent');
});

test('a dismissed or already-confirmed suggestion does not confirm again (AC#3/AC#4)', () => {
  for (const status of ['confirmed', 'dismissed', 'expired', 'failed'] as const) {
    const d = decideGrocerySuggestion({
      intent: { kind: 'grocery_request', item: 'Tomato', quantity: null },
      role: 'cook',
      language: 'en',
      suggestion: { status, expiresAt: future },
      now,
    });
    assert.equal(d.ok, false, `status ${status} should not confirm`);
    if (!d.ok) assert.equal(d.reason, 'suggestion_not_pending');
  }
});

test('an expired suggestion does not confirm (AC#3 — private suggestions expire)', () => {
  const d = decideGrocerySuggestion({
    intent: { kind: 'grocery_request', item: 'Tomato', quantity: null },
    role: 'cook',
    language: 'en',
    suggestion: { status: 'pending', expiresAt: '2026-07-27T09:00:00Z' },
    now,
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'suggestion_expired');
});

// ---- normalizeItemText / findSimilarPendingRequest ----

test('normalizeItemText lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalizeItemText('  Tomato! '), 'tomato');
  assert.equal(normalizeItemText('Tomato,'), 'tomato');
  assert.equal(normalizeItemText('टमाटर'), 'टमाटर');
  assert.equal(normalizeItemText('  टमाटर  '), 'टमाटर');
});

test('findSimilarPendingRequest matches a normalized pending request (AC#5)', () => {
  const existing = makeRequest({
    id: 'gr-old' as GroceryRequest['id'],
    itemText: 'tomato',
    createdAt: '2026-07-27T08:00:00Z',
  });
  const found = findSimilarPendingRequest(
    [existing, makeRequest({ itemText: 'Onion' })],
    'Tomato!',
  );
  assert.equal(found?.id, existing.id);
});

test('findSimilarPendingRequest ignores approved/rejected/cancelled requests', () => {
  const approved = makeRequest({ status: 'approved', itemText: 'tomato' });
  assert.equal(findSimilarPendingRequest([approved], 'Tomato'), null);
});

test('findSimilarPendingRequest excludes the request being updated (AC#5 — not self-matching)', () => {
  const me = makeRequest({ id: 'gr-me' as GroceryRequest['id'], itemText: 'tomato' });
  assert.equal(findSimilarPendingRequest([me], 'Tomato', me.id), null);
});

test('findSimilarPendingRequest returns null when nothing matches', () => {
  assert.equal(findSimilarPendingRequest([makeRequest({ itemText: 'Onion' })], 'Tomato'), null);
});

// ---- decideRequestUpdate (Cook edits/cancels) ----

test('a cook may update item/quantity on a pending request (AC#6)', () => {
  const d = decideRequestUpdate({
    current: makeRequest({ version: 1 }),
    expectedVersion: 1,
    patch: { quantityText: '2 kg' },
    now,
  });
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.next.quantityText, '2 kg');
    assert.equal(d.next.status, 'pending');
    assert.equal(d.next.version, 2);
  }
});

test('a cook may cancel a pending request (AC#6)', () => {
  const d = decideRequestUpdate({
    current: makeRequest({ version: 1 }),
    expectedVersion: 1,
    patch: { status: 'cancelled' },
    now,
  });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.next.status, 'cancelled');
});

test('a cook cannot change a request after Member approval (AC#6)', () => {
  for (const status of ['approved', 'rejected', 'in_order', 'fulfilled'] as const) {
    const d = decideRequestUpdate({
      current: makeRequest({ status, version: 1 }),
      expectedVersion: 1,
      patch: { quantityText: '2 kg' },
      now,
    });
    assert.equal(d.ok, false, `status ${status} should lock cook edits`);
    if (!d.ok) assert.equal(d.reason, 'locked_after_approval');
  }
});

test('a stale cook edit is rejected with the current state for fresh confirmation (AC#6)', () => {
  const d = decideRequestUpdate({
    current: makeRequest({ version: 3 }),
    expectedVersion: 1,
    patch: { quantityText: '2 kg' },
    now,
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'stale_version');
});

test('an empty item on update is rejected (AC#2 — essential info)', () => {
  const d = decideRequestUpdate({
    current: makeRequest({ version: 1 }),
    expectedVersion: 1,
    patch: { itemText: '   ' },
    now,
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'empty_item');
});

test('cookMayMutate is true only while pending', () => {
  assert.equal(cookMayMutate('pending'), true);
  assert.equal(cookMayMutate('approved'), false);
  assert.equal(cookMayMutate('fulfilled'), false);
});

// ---- decideRequestResolution (Member approve/reject/order now) ----

test('a member may approve a pending request (AC#7)', () => {
  const d = decideRequestResolution({
    current: makeRequest({ version: 1 }),
    expectedVersion: 1,
    resolution: 'approve',
  });
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.nextStatus, 'approved');
    assert.equal(d.orderNow, false);
    assert.equal(d.version, 2);
  }
});

test('a member may reject a pending request (AC#7)', () => {
  const d = decideRequestResolution({
    current: makeRequest({ version: 1 }),
    expectedVersion: 1,
    resolution: 'reject',
  });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.nextStatus, 'rejected');
});

test('"order now" approves for the next cart but never places an order (AC#7/AC#8)', () => {
  const d = decideRequestResolution({
    current: makeRequest({ version: 1 }),
    expectedVersion: 1,
    resolution: 'order_now',
  });
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.nextStatus, 'approved');
    assert.equal(d.orderNow, true);
    assertNoOrderPlacement(d);
  }
});

test('a member cannot resolve a non-pending request (AC#7)', () => {
  const d = decideRequestResolution({
    current: makeRequest({ status: 'approved', version: 1 }),
    expectedVersion: 1,
    resolution: 'approve',
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'not_pending');
});

test('a stale member resolution is rejected with the current state (AC#7)', () => {
  const d = decideRequestResolution({
    current: makeRequest({ version: 2 }),
    expectedVersion: 1,
    resolution: 'approve',
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'stale_version');
});

test('assertNoOrderPlacement never throws for approve/reject/order_now', () => {
  for (const resolution of ['approve', 'reject', 'order_now'] as const) {
    const d = decideRequestResolution({
      current: makeRequest({ version: 1 }),
      expectedVersion: 1,
      resolution,
    });
    assert.doesNotThrow(() => assertNoOrderPlacement(d));
  }
});

// ---- i18n labels ----

test('memberActionLabels render in English and Hindi', () => {
  assert.equal(memberActionLabels('en').approve, 'Approve');
  assert.equal(memberActionLabels('hi').orderNow, 'अभी ऑर्डर करें');
});

test('similarityChoiceLabels render in English and Hindi (AC#5)', () => {
  assert.equal(similarityChoiceLabels('en').keepSeparate, 'Keep separate');
  assert.equal(similarityChoiceLabels('hi').updateQuantity, 'मात्रा बदलें');
});

test('conflictActorLabel renders in the viewer language', () => {
  assert.equal(conflictActorLabel('Cook B', 'en'), 'Cook B changed this');
  assert.match(conflictActorLabel('Cook B', 'hi'), /बदला/);
});

// ---- end-to-end domain flow against the InMemoryRepository ----
//
// Proves the policy + repository compose into the ticket-08 flow without a
// database: detect a Cook's Hindi grocery intent → persist a private
// suggestion → confirm via the policy → create a pending Grocery Request +
// attributed event → a Member approves → the Cook can no longer mutate it →
// "order now" never places an order.

async function setupHousehold() {
  const repo = new InMemoryRepository();
  const auth = new Authorization(repo);
  const owner = await repo.createUser({
    id: id<'UserId'>('u-owner'),
    clerkUserId: 'co',
    phone: '+919700000001',
    displayName: 'Owner',
  });
  const cook = await repo.createUser({
    id: id<'UserId'>('u-cook'),
    clerkUserId: 'cc',
    phone: '+919700000002',
    displayName: 'Cook',
  });
  const { household } = await repo.createHousehold(
    {
      name: 'H',
      photoUrl: null,
      servingCount: 4,
      mealStyle: 'north',
      dietStyle: 'vegetarian',
      healthEmphasis: [],
      specialMealEnabled: false,
      defaultLanguage: 'hi',
    },
    owner.id,
  );
  const cookMembership = await repo.addMembership(household.id, cook.id, 'cook');
  const ownerMembership = (await repo.listMembers(household.id)).find((m) => m.role === 'owner')!;
  return { repo, auth, household, cook, owner, cookMembership, ownerMembership };
}

test('end-to-end: cook Hindi message → confirm → pending request → member approves → cook locked (AC#1/4/6/7/8)', async () => {
  const { repo, household, cookMembership, ownerMembership } = await setupHousehold();
  const now = new Date('2026-07-27T10:00:00Z');

  // 1. The Cook's Hindi message is detected as a grocery_request intent.
  const intent = detectIntent('नारियल चाहिए');
  assert.equal(intent.kind, 'grocery_request');

  // 2. A private suggestion is persisted for the Cook (AC#3).
  const suggestion = await repo.createSuggestion(household.id, {
    authorId: cookMembership.id,
    sourceMessageId: null,
    intent,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });

  // 3. The Cook confirms; the policy validates and the repository creates the
  //    pending Grocery Request + attributed system event (AC#4).
  const decision = decideGrocerySuggestion({
    intent: suggestion.intent,
    role: 'cook',
    language: 'hi',
    suggestion: { status: suggestion.status, expiresAt: suggestion.expiresAt },
    now,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.action, 'create_grocery_request');
  const { request, event } = await repo.createGroceryRequest(
    household.id,
    { itemText: decision.item, quantityText: decision.quantity },
    cookMembership.id,
  );
  assert.equal(request.status, 'pending');
  assert.equal(event.type, 'grocery_request.created');
  await repo.updateSuggestionStatus(household.id, suggestion.id as string, 'confirmed');

  // 4. A similar second Cook message is surfaced, never silently merged (AC#5).
  const householdRequests = await repo.listGroceryRequests(household.id);
  const similar = findSimilarPendingRequest(householdRequests, 'नारियल');
  assert.ok(similar);
  assert.equal(similar!.id, request.id);

  // 5. Either Cook may update the pending request (AC#6).
  const updateDecision = decideRequestUpdate({
    current: request,
    expectedVersion: request.version,
    patch: { quantityText: '2' },
    now,
  });
  assert.equal(updateDecision.ok, true);

  // 6. The Member "order now" approves for the next cart, never placing an
  //    order (AC#7/AC#8).
  const current = (await repo.getGroceryRequest(request.id))!;
  const resolution = decideRequestResolution({
    current,
    expectedVersion: current.version,
    resolution: 'order_now',
  });
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assertNoOrderPlacement(resolution);
  await repo.updateGroceryRequest(
    household.id,
    request.id,
    current.version,
    { status: resolution.nextStatus, resolvedById: ownerMembership.id },
    ownerMembership.id,
  );

  // 7. After approval, a Cook can no longer mutate the request (AC#6).
  const approved = (await repo.getGroceryRequest(request.id))!;
  assert.equal(approved.status, 'approved');
  const lateCookEdit = decideRequestUpdate({
    current: approved,
    expectedVersion: approved.version,
    patch: { quantityText: '9' },
    now,
  });
  assert.equal(lateCookEdit.ok, false);
  if (!lateCookEdit.ok) assert.equal(lateCookEdit.reason, 'locked_after_approval');
});
