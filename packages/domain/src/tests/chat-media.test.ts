import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandId } from '../ids.js';
import {
  MAX_CAPTION_LENGTH,
  MAX_VOICE_DURATION_MS,
  canCorrectTranscript,
  detectMessageIntent,
  effectiveTranscript,
  intentSourceText,
  isAutomaticTranscript,
  isMediaAccessible,
  validateMessageShape,
} from '../chat-media.js';
import type { ChatMessage, VoiceTranscript } from '../domain-types.js';

const BASE = '2026-07-01T10:00:00.000Z';

function voiceMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm' as never,
    householdId: 'h' as never,
    senderId: 'me' as never,
    kind: 'voice',
    body: null,
    caption: null,
    mediaRef: 'r2://h/voice1',
    clientCreatedAt: BASE,
    serverCreatedAt: BASE,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function photoMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm' as never,
    householdId: 'h' as never,
    senderId: 'me' as never,
    kind: 'photo',
    body: null,
    caption: null,
    mediaRef: 'r2://h/photo1',
    clientCreatedAt: BASE,
    serverCreatedAt: BASE,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function textMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
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

function transcript(overrides: Partial<VoiceTranscript> = {}): VoiceTranscript {
  return {
    messageId: 'm' as never,
    language: 'hi',
    transcript: 'नारियल चाहिए',
    status: 'ready',
    correctedTranscript: null,
    ...overrides,
  };
}

// ---- validateMessageShape ----

test('a text message requires a body and forbids media/caption', () => {
  assert.equal(
    validateMessageShape({ kind: 'text', body: 'hi', caption: null, mediaRef: null }).ok,
    true,
  );
  assert.equal(
    validateMessageShape({ kind: 'text', body: '  ', caption: null, mediaRef: null }).ok,
    false,
  );
  assert.equal(
    validateMessageShape({ kind: 'text', body: 'hi', caption: 'cap', mediaRef: null }).ok,
    false,
  );
  assert.equal(
    validateMessageShape({ kind: 'text', body: 'hi', caption: null, mediaRef: 'ref' }).ok,
    false,
  );
});

test('a photo message requires a mediaRef, allows an optional caption, forbids a body', () => {
  assert.equal(
    validateMessageShape({ kind: 'photo', body: null, caption: null, mediaRef: 'ref' }).ok,
    true,
  );
  assert.equal(
    validateMessageShape({ kind: 'photo', body: null, caption: 'a caption', mediaRef: 'ref' }).ok,
    true,
  );
  assert.equal(
    validateMessageShape({ kind: 'photo', body: null, caption: null, mediaRef: null }).ok,
    false,
  );
  assert.equal(
    validateMessageShape({ kind: 'photo', body: 'body', caption: null, mediaRef: 'ref' }).ok,
    false,
  );
});

test('a voice message requires a mediaRef and forbids both body and caption', () => {
  assert.equal(
    validateMessageShape({ kind: 'voice', body: null, caption: null, mediaRef: 'ref' }).ok,
    true,
  );
  assert.equal(
    validateMessageShape({ kind: 'voice', body: null, caption: null, mediaRef: null }).ok,
    false,
  );
  assert.equal(
    validateMessageShape({ kind: 'voice', body: null, caption: 'cap', mediaRef: 'ref' }).ok,
    false,
  );
  assert.equal(
    validateMessageShape({ kind: 'voice', body: 'body', caption: null, mediaRef: 'ref' }).ok,
    false,
  );
});

test('a caption longer than the bound is rejected', () => {
  const long = 'x'.repeat(MAX_CAPTION_LENGTH + 1);
  assert.equal(
    validateMessageShape({ kind: 'photo', body: null, caption: long, mediaRef: 'ref' }).ok,
    false,
  );
});

test('the voice bound is two minutes', () => {
  assert.equal(MAX_VOICE_DURATION_MS, 120_000);
});

// ---- canCorrectTranscript ----

test('the author may correct a voice transcript within the 15-minute window', () => {
  const now = new Date(BASE);
  now.setSeconds(now.getSeconds() + 60);
  const decision = canCorrectTranscript({
    actorId: brandId<'MembershipId'>('me'),
    message: voiceMessage(),
    correctedText: 'नारियल 2 चाहिए',
    now,
  });
  assert.equal(decision.ok, true);
});

test('a non-voice message cannot have its transcript corrected', () => {
  const decision = canCorrectTranscript({
    actorId: brandId<'MembershipId'>('me'),
    message: textMessage(),
    correctedText: 'x',
    now: new Date(BASE),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'not_voice');
});

test('only the author may correct the transcript', () => {
  const decision = canCorrectTranscript({
    actorId: brandId<'MembershipId'>('someone-else'),
    message: voiceMessage(),
    correctedText: 'x',
    now: new Date(BASE),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'not_author');
});

test('an empty correction is rejected', () => {
  const decision = canCorrectTranscript({
    actorId: brandId<'MembershipId'>('me'),
    message: voiceMessage(),
    correctedText: '   ',
    now: new Date(BASE),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'empty');
});

test('transcript correction is rejected after the edit window', () => {
  const later = new Date(BASE);
  later.setMinutes(later.getMinutes() + 16);
  const decision = canCorrectTranscript({
    actorId: brandId<'MembershipId'>('me'),
    message: voiceMessage(),
    correctedText: 'x',
    now: later,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'window_expired');
});

test('a deleted voice message cannot have its transcript corrected', () => {
  const decision = canCorrectTranscript({
    actorId: brandId<'MembershipId'>('me'),
    message: voiceMessage({ deletedAt: '2026-07-01T10:01:00.000Z' }),
    correctedText: 'x',
    now: new Date(BASE),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'deleted');
});

// ---- effectiveTranscript / isAutomaticTranscript ----

test('effectiveTranscript prefers the corrected transcript', () => {
  const t = transcript({ correctedTranscript: 'नारियल 2 चाहिए' });
  assert.equal(effectiveTranscript(t), 'नारियल 2 चाहिए');
});

test('effectiveTranscript falls back to the automatic transcript', () => {
  const t = transcript({ correctedTranscript: null });
  assert.equal(effectiveTranscript(t), 'नारियल चाहिए');
});

test('effectiveTranscript is null when the transcript is not ready', () => {
  assert.equal(effectiveTranscript(transcript({ status: 'pending' })), null);
  assert.equal(effectiveTranscript(transcript({ status: 'failed' })), null);
  assert.equal(effectiveTranscript(null), null);
});

test('an uncorrected ready transcript is labelled automatic', () => {
  assert.equal(isAutomaticTranscript(transcript({ correctedTranscript: null })), true);
  assert.equal(isAutomaticTranscript(transcript({ correctedTranscript: 'fixed' })), false);
  assert.equal(isAutomaticTranscript(transcript({ status: 'pending' })), false);
});

// ---- intentSourceText / detectMessageIntent ----

test('intent source text is the body for a text message', () => {
  assert.equal(intentSourceText(textMessage({ body: 'नारियल चाहिए' }), null), 'नारियल चाहिए');
});

test('intent source text is the caption for a photo message', () => {
  assert.equal(intentSourceText(photoMessage({ caption: 'नारियल चाहिए' }), null), 'नारियल चाहिए');
  assert.equal(intentSourceText(photoMessage({ caption: null }), null), null);
});

test('intent source text is the effective transcript for a voice message', () => {
  assert.equal(intentSourceText(voiceMessage(), transcript()), 'नारियल चाहिए');
  assert.equal(
    intentSourceText(voiceMessage(), transcript({ correctedTranscript: 'हल्दी चाहिए' })),
    'हल्दी चाहिए',
  );
  assert.equal(intentSourceText(voiceMessage(), transcript({ status: 'pending' })), null);
});

test('detectMessageIntent re-runs against the corrected transcript', () => {
  const corrected = transcript({ correctedTranscript: 'नारियल चाहिए' });
  const intent = detectMessageIntent(voiceMessage(), corrected);
  assert.equal(intent.kind, 'grocery_request');
});

test('detectMessageIntent re-runs against a corrected photo caption', () => {
  const intent = detectMessageIntent(photoMessage({ caption: 'नारियल चाहिए' }), null);
  assert.equal(intent.kind, 'grocery_request');
});

test('detectMessageIntent is unknown for a photo without a caption', () => {
  assert.equal(detectMessageIntent(photoMessage({ caption: null }), null).kind, 'unknown');
});

test('detectMessageIntent is unknown for a voice note with no ready transcript', () => {
  assert.equal(
    detectMessageIntent(voiceMessage(), transcript({ status: 'pending' })).kind,
    'unknown',
  );
});

// ---- isMediaAccessible ----

test('media is accessible to a member of the owning household when not deleted', () => {
  assert.equal(isMediaAccessible(voiceMessage(), 'h'), true);
});

test('media is not accessible after deletion', () => {
  assert.equal(
    isMediaAccessible(voiceMessage({ deletedAt: '2026-07-01T10:01:00.000Z' }), 'h'),
    false,
  );
});

test('media is not accessible from another household', () => {
  assert.equal(isMediaAccessible(voiceMessage(), 'other-household'), false);
});

test('a message with no mediaRef is not media-accessible', () => {
  assert.equal(isMediaAccessible(voiceMessage({ mediaRef: null }), 'h'), false);
});
