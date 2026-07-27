import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from '../ids.js';
import type {
  ChatMessage,
  DeviceRegistration,
  Household,
  HouseholdMemberState,
  Membership,
  SystemEvent,
} from '../types.js';
import {
  effectiveLevel,
  resolveRecipientsForEvent,
  resolveRecipientsForMessage,
  buildEventPushes,
  buildMessagePushes,
  dispatchEventPushes,
  dispatchMessagePushes,
  RecordingPushDispatcher,
  countUnread,
  type ResolveRecipientsInput,
} from '../push-dispatch.js';
import { collapseKey } from '../notifications.js';

const householdId = id<'HouseholdId'>('h1');
const cookUserId = id<'UserId'>('u-cook');
const memberUserId = id<'UserId'>('u-member');
const ownerUserId = id<'UserId'>('u-owner');
const cookMembershipId = id<'MembershipId'>('m-cook');
const memberMembershipId = id<'MembershipId'>('m-member');
const ownerMembershipId = id<'MembershipId'>('m-owner');

function makeHousehold(): Household {
  return {
    id: householdId,
    name: 'Sharma',
    photoUrl: null,
    servingCount: 4,
    mealStyle: 'north',
    dietStyle: 'vegetarian',
    healthEmphasis: [],
    specialMealEnabled: false,
    defaultLanguage: 'en',
    createdAt: '2025-01-01T00:00:00.000Z',
    closedAt: null,
  };
}

function makeMembership(
  membershipId: string,
  userId: string,
  role: 'owner' | 'member' | 'cook',
  notificationDefault: 'all' | 'important' | 'muted',
): Membership {
  return {
    id: id<'MembershipId'>(membershipId),
    userId: id<'UserId'>(userId),
    householdId,
    role,
    status: 'active',
    notificationDefault,
    joinedAt: '2025-01-01T00:00:00.000Z',
    removedAt: null,
  };
}

function makeDevice(
  userId: string,
  token: string,
  opts: { hidePreviews?: boolean; invalidatedAt?: string | null } = {},
): DeviceRegistration {
  return {
    id: id<'DeviceId'>(`dev-${token}`),
    userId: id<'UserId'>(userId),
    pushToken: token,
    platform: 'ios',
    hidePreviews: opts.hidePreviews ?? false,
    invalidatedAt: opts.invalidatedAt ?? null,
  };
}

function makeMemberState(
  userId: string,
  override: 'all' | 'important' | 'muted' | null,
): HouseholdMemberState {
  return {
    userId: id<'UserId'>(userId),
    householdId,
    lastReadMessageId: null,
    notificationOverride: override,
  };
}

function makeBaseInput(actorMembershipId: string | null): ResolveRecipientsInput {
  return {
    householdId,
    actorMembershipId: actorMembershipId ? id<'MembershipId'>(actorMembershipId) : null,
    members: [
      makeMembership(ownerMembershipId, ownerUserId, 'owner', 'all'),
      makeMembership(memberMembershipId, memberUserId, 'member', 'all'),
      makeMembership(cookMembershipId, cookUserId, 'cook', 'important'),
    ],
    memberStates: [],
    devices: [
      makeDevice(ownerUserId, 'token-owner'),
      makeDevice(memberUserId, 'token-member'),
      makeDevice(cookUserId, 'token-cook'),
    ],
  };
}

function makeEvent(type: SystemEvent['type'], actorId: string | null): SystemEvent {
  return {
    id: id<'SystemEventId'>('e1'),
    householdId,
    type,
    actorId: actorId ? id<'MembershipId'>(actorId) : null,
    entityType: 'test',
    entityId: 'ent1',
    payload: {},
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

function makeMessage(senderId: string, body: string): ChatMessage {
  return {
    id: id<'ChatMessageId'>('msg1'),
    householdId,
    senderId: id<'MembershipId'>(senderId),
    kind: 'text',
    body,
    caption: null,
    mediaRef: null,
    clientCreatedAt: '2025-01-01T00:00:00.000Z',
    serverCreatedAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
    deletedAt: null,
  };
}

// ---- effectiveLevel ----

test('effectiveLevel: cook defaults to important, member defaults to all', () => {
  const cook = makeMembership(cookMembershipId, cookUserId, 'cook', 'important');
  const member = makeMembership(memberMembershipId, memberUserId, 'member', 'all');
  assert.equal(effectiveLevel(cook, null), 'important');
  assert.equal(effectiveLevel(member, null), 'all');
});

test('effectiveLevel: per-household override wins over role default', () => {
  const cook = makeMembership(cookMembershipId, cookUserId, 'cook', 'important');
  const mutedState = makeMemberState(cookUserId, 'muted');
  assert.equal(effectiveLevel(cook, mutedState), 'muted');
  const allState = makeMemberState(cookUserId, 'all');
  assert.equal(effectiveLevel(cook, allState), 'all');
});

test('effectiveLevel: null override restores the role default', () => {
  const cook = makeMembership(cookMembershipId, cookUserId, 'cook', 'important');
  const nullState = makeMemberState(cookUserId, null);
  assert.equal(effectiveLevel(cook, nullState), 'important');
});

// ---- resolveRecipientsForEvent ----

test('resolveRecipientsForEvent: actor never receives own push (AC#5)', () => {
  const input = makeBaseInput(cookMembershipId);
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_request.created',
    sameDayMeal: false,
  });
  const tokens = recipients.map((r) => r.device.pushToken);
  assert.ok(!tokens.includes('token-cook'), 'cook (actor) should not be in recipients');
});

test('resolveRecipientsForEvent: member gets All activity by default, cook gets Important only (AC#1/AC#3)', () => {
  const input = makeBaseInput(null);
  // A non-important event for cooks (future meal change)
  const recipients = resolveRecipientsForEvent(input, {
    type: 'meal.changed',
    sameDayMeal: false,
  });
  const tokens = recipients.map((r) => r.device.pushToken);
  // member (all) and owner (all) get it; cook (important only) does not
  assert.ok(tokens.includes('token-member'));
  assert.ok(tokens.includes('token-owner'));
  assert.ok(!tokens.includes('token-cook'));
});

test('resolveRecipientsForEvent: same-day meal change is important for all roles (AC#3)', () => {
  const input = makeBaseInput(null);
  const recipients = resolveRecipientsForEvent(input, {
    type: 'meal.changed',
    sameDayMeal: true,
  });
  const tokens = recipients.map((r) => r.device.pushToken);
  assert.ok(tokens.includes('token-cook'), 'cook should receive same-day meal change');
  assert.ok(tokens.includes('token-member'));
});

test('resolveRecipientsForEvent: muted recipient is excluded (AC#2)', () => {
  const input = makeBaseInput(null);
  input.memberStates = [makeMemberState(memberUserId, 'muted')];
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_request.created',
    sameDayMeal: false,
  });
  const tokens = recipients.map((r) => r.device.pushToken);
  assert.ok(!tokens.includes('token-member'), 'muted member should not receive push');
});

test('resolveRecipientsForEvent: invalidated devices are excluded (AC#8)', () => {
  const input = makeBaseInput(null);
  input.devices = [
    makeDevice(ownerUserId, 'token-owner'),
    makeDevice(memberUserId, 'token-member', { invalidatedAt: '2025-01-01' }),
    makeDevice(cookUserId, 'token-cook'),
  ];
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_request.approved',
    sameDayMeal: false,
  });
  const tokens = recipients.map((r) => r.device.pushToken);
  assert.ok(!tokens.includes('token-member'), 'invalidated device should not receive push');
});

test('resolveRecipientsForEvent: removed memberships are excluded', () => {
  const input = makeBaseInput(null);
  input.members = input.members.map((m) =>
    m.id === memberMembershipId ? { ...m, status: 'removed' as const } : m,
  );
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_request.created',
    sameDayMeal: false,
  });
  const tokens = recipients.map((r) => r.device.pushToken);
  assert.ok(!tokens.includes('token-member'), 'removed member should not receive push');
});

// ---- resolveRecipientsForMessage ----

test('resolveRecipientsForMessage: sender never receives own message push (AC#5)', () => {
  const input = makeBaseInput(cookMembershipId);
  const recipients = resolveRecipientsForMessage(input);
  const tokens = recipients.map((r) => r.device.pushToken);
  assert.ok(!tokens.includes('token-cook'));
  assert.ok(tokens.includes('token-member'));
  assert.ok(tokens.includes('token-owner'));
});

test('resolveRecipientsForMessage: muted recipient excluded; All and Important both get human messages (AC#2/AC#3)', () => {
  const input = makeBaseInput(memberMembershipId);
  input.memberStates = [makeMemberState(cookUserId, 'muted')];
  const recipients = resolveRecipientsForMessage(input);
  const tokens = recipients.map((r) => r.device.pushToken);
  assert.ok(!tokens.includes('token-cook'), 'muted cook excluded');
  assert.ok(!tokens.includes('token-member'), 'actor (member) excluded');
  assert.ok(tokens.includes('token-owner'));
});

// ---- buildEventPushes / collapseKey ----

test('buildEventPushes: all pushes from one household share a collapse key (AC#4)', () => {
  const input = makeBaseInput(null);
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_request.created',
    sameDayMeal: false,
  });
  const event = makeEvent('grocery_request.created', null);
  const pushes = buildEventPushes(makeHousehold(), recipients, event, 'Need milk');
  assert.ok(pushes.length > 0);
  const expectedKey = collapseKey(householdId);
  for (const p of pushes) {
    assert.equal(p.collapseKey, expectedKey);
  }
});

test('buildEventPushes: money-sensitive events produce redacted previews (AC#6)', () => {
  const input = makeBaseInput(null);
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_order.placed',
    sameDayMeal: false,
  });
  const event = makeEvent('grocery_order.placed', null);
  const pushes = buildEventPushes(makeHousehold(), recipients, event, 'Order for Rs 499');
  for (const p of pushes) {
    assert.ok(!p.body.includes('499'), 'body should not contain money');
    assert.equal(p.body, 'Grocery order update');
  }
});

test('buildEventPushes: checkout failure is redacted to generic text (AC#6)', () => {
  const input = makeBaseInput(null);
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_order.failed',
    sameDayMeal: false,
  });
  const event = makeEvent('grocery_order.failed', null);
  const pushes = buildEventPushes(makeHousehold(), recipients, event, 'Checkout failed for Rs 499');
  for (const p of pushes) {
    assert.equal(p.body, 'Checkout needs attention');
    assert.ok(!p.body.includes('499'));
  }
});

test('buildEventPushes: hidePreviews produces generic text with no detail (AC#6)', () => {
  const input = makeBaseInput(null);
  input.devices = [
    makeDevice(ownerUserId, 'token-owner', { hidePreviews: true }),
    makeDevice(memberUserId, 'token-member'),
  ];
  const recipients = resolveRecipientsForEvent(input, {
    type: 'grocery_request.created',
    sameDayMeal: false,
  });
  const event = makeEvent('grocery_request.created', null);
  const pushes = buildEventPushes(makeHousehold(), recipients, event, 'Need milk');
  const hidden = pushes.find((p) => p.token === 'token-owner')!;
  assert.equal(hidden.body, 'New Cooklink activity');
  assert.ok(!hidden.body.includes('milk'));
  const visible = pushes.find((p) => p.token === 'token-member')!;
  assert.ok(visible.body.includes('milk'));
});

// ---- buildMessagePushes ----

test('buildMessagePushes: messages share collapse key; body includes preview text', () => {
  const input = makeBaseInput(cookMembershipId);
  const recipients = resolveRecipientsForMessage(input);
  const msg = makeMessage(cookMembershipId, 'Bring milk tomorrow');
  const pushes = buildMessagePushes(
    makeHousehold(),
    recipients,
    msg,
    'Meera',
    'Bring milk tomorrow',
  );
  assert.ok(pushes.length > 0);
  for (const p of pushes) {
    assert.equal(p.collapseKey, collapseKey(householdId));
    assert.equal(p.kind, 'message');
  }
});

test('buildMessagePushes: hidePreviews on a device hides message content (AC#6)', () => {
  const input = makeBaseInput(cookMembershipId);
  input.devices = [
    makeDevice(ownerUserId, 'token-owner', { hidePreviews: true }),
    makeDevice(memberUserId, 'token-member'),
  ];
  const recipients = resolveRecipientsForMessage(input);
  const msg = makeMessage(cookMembershipId, 'Secret recipe');
  const pushes = buildMessagePushes(makeHousehold(), recipients, msg, 'Meera', 'Secret recipe');
  const hidden = pushes.find((p) => p.token === 'token-owner')!;
  assert.equal(hidden.body, 'New Cooklink activity');
});

// ---- dispatchEventPushes / invalid tokens ----

test('dispatchEventPushes: delivers to resolved recipients and retires invalid tokens (AC#8)', async () => {
  const input = makeBaseInput(cookMembershipId);
  // member's token is invalid
  const dispatcher = new RecordingPushDispatcher();
  dispatcher.setResult('token-member', { ok: false, reason: 'invalid_token' });
  const event = makeEvent('grocery_request.created', cookMembershipId);
  const result = await dispatchEventPushes(
    dispatcher,
    makeHousehold(),
    input,
    { type: 'grocery_request.created', sameDayMeal: false },
    event,
    'Need milk',
  );
  // owner gets it (all), member gets it (all) but token is invalid, cook is actor (excluded)
  assert.equal(result.delivered, 1); // only owner
  assert.deepEqual(result.invalidTokens, ['token-member']);
});

test('dispatchMessagePushes: delivers message pushes and retires invalid tokens', async () => {
  const input = makeBaseInput(cookMembershipId);
  const dispatcher = new RecordingPushDispatcher();
  dispatcher.setResult('token-owner', { ok: false, reason: 'invalid_token' });
  const msg = makeMessage(cookMembershipId, 'Hello');
  const result = await dispatchMessagePushes(
    dispatcher,
    makeHousehold(),
    input,
    msg,
    'Meera',
    'Hello',
  );
  // owner token invalid, member gets it, cook is actor
  assert.equal(result.delivered, 1); // only member
  assert.deepEqual(result.invalidTokens, ['token-owner']);
});

test('RecordingPushDispatcher captures all sent notifications', async () => {
  const dispatcher = new RecordingPushDispatcher();
  await dispatcher.dispatch({
    token: 't1',
    title: 'Test',
    body: 'Body',
    collapseKey: 'k',
    householdId,
    kind: 'message',
    entityId: null,
  });
  assert.equal(dispatcher.sent.length, 1);
  assert.equal(dispatcher.sent[0]!.token, 't1');
});

// ---- countUnread ----

test('countUnread: all messages unread when no lastRead', () => {
  const messages = [
    makeMessage(cookMembershipId, 'a'),
    makeMessage(cookMembershipId, 'b'),
    makeMessage(cookMembershipId, 'c'),
  ];
  assert.equal(countUnread(messages, null), 3);
});

test('countUnread: counts messages after lastRead', () => {
  const messages = [
    { ...makeMessage(cookMembershipId, 'a'), id: id<'ChatMessageId'>('m1') },
    { ...makeMessage(cookMembershipId, 'b'), id: id<'ChatMessageId'>('m2') },
    { ...makeMessage(cookMembershipId, 'c'), id: id<'ChatMessageId'>('m3') },
  ];
  const state: HouseholdMemberState = {
    userId: memberUserId,
    householdId,
    lastReadMessageId: id<'ChatMessageId'>('m1'),
    notificationOverride: null,
  };
  assert.equal(countUnread(messages, state), 2);
});

test('countUnread: deleted messages are not counted', () => {
  const messages = [
    { ...makeMessage(cookMembershipId, 'a'), id: id<'ChatMessageId'>('m1') },
    {
      ...makeMessage(cookMembershipId, 'b'),
      id: id<'ChatMessageId'>('m2'),
      deletedAt: '2025-01-02',
    },
    { ...makeMessage(cookMembershipId, 'c'), id: id<'ChatMessageId'>('m3') },
  ];
  const state: HouseholdMemberState = {
    userId: memberUserId,
    householdId,
    lastReadMessageId: id<'ChatMessageId'>('m1'),
    notificationOverride: null,
  };
  assert.equal(countUnread(messages, state), 1);
});

test('countUnread: lastRead not in window means all are unread', () => {
  const messages = [
    { ...makeMessage(cookMembershipId, 'a'), id: id<'ChatMessageId'>('m1') },
    { ...makeMessage(cookMembershipId, 'b'), id: id<'ChatMessageId'>('m2') },
  ];
  const state: HouseholdMemberState = {
    userId: memberUserId,
    householdId,
    lastReadMessageId: id<'ChatMessageId'>('nonexistent'),
    notificationOverride: null,
  };
  assert.equal(countUnread(messages, state), 2);
});

// ---- membership join defaults ----

test('AC#1: new memberships default Members to All, Cooks to Important', () => {
  const memberM = makeMembership(memberMembershipId, memberUserId, 'member', 'all');
  const cookM = makeMembership(cookMembershipId, cookUserId, 'cook', 'important');
  assert.equal(effectiveLevel(memberM, null), 'all');
  assert.equal(effectiveLevel(cookM, null), 'important');
});
