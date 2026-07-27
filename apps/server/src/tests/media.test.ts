import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMediaStore } from '../media.js';

/**
 * InMemoryMediaStore unit tests (ticket 06). The store is the authorization
 * boundary for private media: a mediaRef is an opaque token tagged with the
 * owning Household, and a cross-Household resolve must never yield bytes
 * (issue 06, AC#8).
 */

test('put returns an opaque mediaRef that is not a public URL', async () => {
  const store = new InMemoryMediaStore();
  const stored = await store.put({
    householdId: 'h-1',
    kind: 'photo',
    contentType: 'image/jpeg',
    data: Buffer.from('fake-jpg-bytes'),
  });
  assert.match(stored.mediaRef, /^media\//);
  assert.equal(stored.householdId, 'h-1');
  assert.equal(stored.kind, 'photo');
  assert.equal(stored.bytes, 'fake-jpg-bytes'.length);
});

test('resolve returns the bytes for the owning household', async () => {
  const store = new InMemoryMediaStore();
  const stored = await store.put({
    householdId: 'h-1',
    kind: 'voice',
    contentType: 'audio/webm',
    data: Buffer.from('voice-bytes'),
  });
  const resolved = await store.resolve(stored.mediaRef, 'h-1');
  assert.ok(resolved);
  assert.equal(resolved!.contentType, 'audio/webm');
  assert.equal(resolved!.data.toString(), 'voice-bytes');
  assert.equal(resolved!.kind, 'voice');
});

test('a cross-household mediaRef resolves to nothing', async () => {
  const store = new InMemoryMediaStore();
  const stored = await store.put({
    householdId: 'h-1',
    kind: 'photo',
    contentType: 'image/jpeg',
    data: Buffer.from('secret-photo'),
  });
  const resolved = await store.resolve(stored.mediaRef, 'h-other');
  assert.equal(resolved, null);
});

test('an unknown mediaRef resolves to nothing', async () => {
  const store = new InMemoryMediaStore();
  const resolved = await store.resolve('media/does-not-exist', 'h-1');
  assert.equal(resolved, null);
});

test('delete revokes access to the media object', async () => {
  const store = new InMemoryMediaStore();
  const stored = await store.put({
    householdId: 'h-1',
    kind: 'photo',
    contentType: 'image/jpeg',
    data: Buffer.from('to-delete'),
  });
  await store.delete(stored.mediaRef);
  const resolved = await store.resolve(stored.mediaRef, 'h-1');
  assert.equal(resolved, null);
});
