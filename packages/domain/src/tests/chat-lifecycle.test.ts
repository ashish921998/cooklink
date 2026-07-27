import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDIT_WINDOW_MS, canEditOrDeleteMessage } from '../chat-lifecycle.js';
import type { ChatMessage } from '../types.js';

const BASE = '2026-07-01T10:00:00.000Z';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm' as never,
    householdId: 'h' as never,
    senderId: 'me' as never,
    kind: 'text',
    body: 'hi',
    caption: null,
    mediaRef: null,
    clientCreatedAt: BASE,
    serverCreatedAt: BASE,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

test('the author may edit or delete within the 15-minute window', () => {
  const now = new Date(BASE);
  now.setSeconds(now.getSeconds() + EDIT_WINDOW_MS / 1000 - 30); // 14m30s
  const decision = canEditOrDeleteMessage({
    actorId: 'me' as never,
    message: message({ senderId: 'me' as never, serverCreatedAt: BASE }),
    now,
  });
  assert.equal(decision.ok, true);
});

test('the edit/delete window expires exactly at 15 minutes', () => {
  const at15 = new Date(BASE);
  at15.setMilliseconds(at15.getMilliseconds() + EDIT_WINDOW_MS);
  const decision = canEditOrDeleteMessage({
    actorId: 'me' as never,
    message: message({ senderId: 'me' as never, serverCreatedAt: BASE }),
    now: at15,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'window_expired');
});

test('only the author may mutate the message', () => {
  const decision = canEditOrDeleteMessage({
    actorId: 'someone-else' as never,
    message: message({ senderId: 'me' as never, serverCreatedAt: BASE }),
    now: new Date(BASE),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'not_author');
});

test('a deleted message can no longer be mutated', () => {
  const decision = canEditOrDeleteMessage({
    actorId: 'me' as never,
    message: message({ deletedAt: '2026-07-01T10:01:00.000Z' }),
    now: new Date(BASE),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'deleted');
});

test('not_author takes precedence over window_expired', () => {
  const far = new Date(BASE);
  far.setHours(far.getHours() + 1);
  const decision = canEditOrDeleteMessage({
    actorId: 'other' as never,
    message: message({ senderId: 'me' as never, serverCreatedAt: BASE }),
    now: far,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'not_author');
});
