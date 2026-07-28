import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '@cooklink/db';
import { createApp } from '../app.js';
import { InMemoryMediaStore } from '../media.js';
import { StubTranscriptionService } from '../transcription.js';

/**
 * Ticket 06 — Add private photo and voice-note Chat, end to end through the
 * Hono app against Postgres. Exercises: media upload returns an opaque mediaRef;
 * a photo message with a caption is sent and read back; a voice message is
 * transcribed server-side; the transcript is correctable and re-runs intent;
 * a caption edit re-runs intent; authorized media access is Household-scoped;
 * cross-Household media access is denied; deleting a message revokes media.
 *
 * Skipped without DATABASE_URL, exactly like the ticket-04 chat route tests.
 */

function devHeaders(suffix: string) {
  return {
    'content-type': 'application/json',
    'x-clerk-user-id': `ticket-06-owner-${suffix}`,
    'x-cooklink-dev-phone': '+919400000061',
    'x-cooklink-dev-name': 'Ticket06 Owner',
  };
}

function intruderHeaders(suffix: string) {
  return {
    'content-type': 'application/json',
    'x-clerk-user-id': `ticket-06-intruder-${suffix}`,
    'x-cooklink-dev-phone': '+919400000099',
    'x-cooklink-dev-name': 'Intruder',
  };
}

test(
  'a photo message with a caption is sent, read back, and its media is privately accessible',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    const media = new InMemoryMediaStore();
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL), {
        media,
        transcription: new StubTranscriptionService(),
      });
      const suffix = crypto.randomUUID();
      const headers = devHeaders(suffix);

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `Ticket 06 ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      // Upload a private photo.
      const uploadRes = await app.request(`/v1/households/${householdId}/chat/media?kind=photo`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'image/jpeg' },
        body: Buffer.from('fake-jpeg-bytes'),
      });
      assert.equal(uploadRes.status, 201);
      const uploaded = (await uploadRes.json()) as { mediaRef: string; kind: string };
      assert.match(uploaded.mediaRef, /^media\//);
      assert.equal(uploaded.kind, 'photo');

      // Send a photo message with a caption.
      const sendRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'photo',
          mediaRef: uploaded.mediaRef,
          caption: 'नारियल चाहिए',
        }),
      });
      assert.equal(sendRes.status, 201);
      const sent = (await sendRes.json()) as {
        item: { messageKind: string; caption: string; mediaRef: string; body: string | null };
      };
      assert.equal(sent.item.messageKind, 'photo');
      assert.equal(sent.item.caption, 'नारियल चाहिए');
      assert.equal(sent.item.mediaRef, uploaded.mediaRef);
      assert.equal(sent.item.body, null);

      // The timeline shows the photo message attributed to the sender.
      const timelineRes = await app.request(`/v1/households/${householdId}/chat`, { headers });
      const timeline = (await timelineRes.json()) as {
        items: { kind: string; messageKind?: string; caption?: string; mediaRef?: string }[];
      };
      assert.equal(timeline.items.length, 1);
      assert.equal(timeline.items[0]!.messageKind, 'photo');
      assert.equal(timeline.items[0]!.caption, 'नारियल चाहिए');

      // Authorized media access proxies the bytes for the owning Household.
      const mediaRes = await app.request(
        `/v1/households/${householdId}/chat/media/${encodeURIComponent(uploaded.mediaRef)}`,
        { headers },
      );
      assert.equal(mediaRes.status, 200);
      assert.equal(mediaRes.headers.get('content-type'), 'image/jpeg');
      assert.equal(await mediaRes.text(), 'fake-jpeg-bytes');
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);

test(
  'a voice message is transcribed server-side and the transcript is correctable',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    const media = new InMemoryMediaStore();
    const transcription = new StubTranscriptionService(async () => ({
      transcript: 'हल्दी चाहिए',
      language: 'hi',
      status: 'ready',
    }));
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL), { media, transcription });
      const suffix = crypto.randomUUID();
      const headers = devHeaders(suffix);

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `Ticket 06 voice ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      // Upload a voice note.
      const uploadRes = await app.request(`/v1/households/${householdId}/chat/media?kind=voice`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'audio/webm' },
        body: Buffer.from('fake-audio-bytes'),
      });
      const uploaded = (await uploadRes.json()) as { mediaRef: string };

      // Send a voice message — transcription starts in pending state and
      // completes asynchronously (ticket 06, AC#4).
      const sendRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'voice', mediaRef: uploaded.mediaRef, durationMs: 5000 }),
      });
      assert.equal(sendRes.status, 201);
      const sent = (await sendRes.json()) as {
        item: {
          id: string;
          messageKind: string;
          transcript: {
            transcript: string | null;
            status: string;
            correctedTranscript: string | null;
          } | null;
          transcriptText: string | null;
          transcriptAutomatic: boolean;
        };
      };
      assert.equal(sent.item.messageKind, 'voice');
      assert.ok(sent.item.transcript);
      // The send response returns the pending transcript; the actual
      // transcription runs asynchronously and is observed on the next poll.
      assert.equal(sent.item.transcript!.status, 'pending');

      const messageId = sent.item.id;

      // Wait for the async transcription to complete, then fetch the timeline
      // to observe the ready transcript.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const timelineRes = await app.request(`/v1/households/${householdId}/chat`, { headers });
      const timeline = (await timelineRes.json()) as {
        items: {
          kind: string;
          messageKind?: string;
          transcript?: { transcript: string | null; status: string } | null;
          transcriptText?: string | null;
          transcriptAutomatic?: boolean;
        }[];
      };
      const voiceItem = timeline.items.find((t) => t.messageKind === 'voice');
      assert.ok(voiceItem);
      assert.ok(voiceItem!.transcript);
      assert.equal(voiceItem!.transcript!.status, 'ready');
      assert.equal(voiceItem!.transcript!.transcript, 'हल्दी चाहिए');
      assert.equal(voiceItem!.transcriptText, 'हल्दी चाहिए');
      assert.equal(voiceItem!.transcriptAutomatic, true);

      // Correct the transcript within the edit window.
      const correctRes = await app.request(
        `/v1/households/${householdId}/chat/messages/${messageId}/transcript`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ correctedTranscript: 'हल्दी 2 पैकेट चाहिए' }),
        },
      );
      assert.equal(correctRes.status, 200);
      const corrected = (await correctRes.json()) as {
        transcript: { correctedTranscript: string; transcript: string };
        intent: { kind: string; item?: string };
      };
      assert.equal(corrected.transcript.correctedTranscript, 'हल्दी 2 पैकेट चाहिए');
      // The original automatic transcript is preserved.
      assert.equal(corrected.transcript.transcript, 'हल्दी चाहिए');
      // Intent detection re-ran against the corrected text.
      assert.equal(corrected.intent.kind, 'grocery_request');
      if (corrected.intent.kind === 'grocery_request') {
        assert.ok(corrected.intent.item);
      }
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);

test(
  'a voice note longer than two minutes is rejected',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();
      const headers = devHeaders(suffix);
      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `Ticket 06 bound ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };
      const sendRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'voice', mediaRef: 'media/x', durationMs: 121_000 }),
      });
      assert.equal(sendRes.status, 400);
      const err = (await sendRes.json()) as { error: string };
      assert.equal(err.error, 'voice_too_long');

      // A voice message without a duration is also rejected — the bound cannot
      // be bypassed by omitting the field.
      const noDurationRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'voice', mediaRef: 'media/x' }),
      });
      assert.equal(noDurationRes.status, 400);
      const noDurErr = (await noDurationRes.json()) as { error: string };
      assert.equal(noDurErr.error, 'voice_duration_required');
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);

test(
  'cross-household media access is denied (ticket 06, AC#8)',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    const media = new InMemoryMediaStore();
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL), {
        media,
        transcription: new StubTranscriptionService(),
      });
      const suffix = crypto.randomUUID();
      const ownerHeaders = devHeaders(suffix);
      const intruderH = intruderHeaders(suffix);

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 06 iso ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      // Upload a photo in the owner's household.
      const uploadRes = await app.request(`/v1/households/${householdId}/chat/media?kind=photo`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'image/jpeg' },
        body: Buffer.from('secret-photo'),
      });
      const uploaded = (await uploadRes.json()) as { mediaRef: string };

      // An authenticated non-member cannot read the media.
      const intruderMediaRes = await app.request(
        `/v1/households/${householdId}/chat/media/${encodeURIComponent(uploaded.mediaRef)}`,
        { headers: intruderH },
      );
      assert.equal(intruderMediaRes.status, 404);

      // An authenticated non-member cannot upload media to this household.
      const intruderUploadRes = await app.request(
        `/v1/households/${householdId}/chat/media?kind=photo`,
        {
          method: 'POST',
          headers: { ...intruderH, 'content-type': 'image/jpeg' },
          body: Buffer.from('intruder-photo'),
        },
      );
      assert.equal(intruderUploadRes.status, 404);
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);

test(
  'deleting a photo message revokes media access (ticket 06)',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    const media = new InMemoryMediaStore();
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL), {
        media,
        transcription: new StubTranscriptionService(),
      });
      const suffix = crypto.randomUUID();
      const headers = devHeaders(suffix);
      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `Ticket 06 del ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      const uploadRes = await app.request(`/v1/households/${householdId}/chat/media?kind=photo`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'image/jpeg' },
        body: Buffer.from('to-delete-photo'),
      });
      const uploaded = (await uploadRes.json()) as { mediaRef: string };

      const sendRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'photo', mediaRef: uploaded.mediaRef }),
      });
      const sent = (await sendRes.json()) as { item: { id: string } };

      // Media is accessible before deletion.
      const before = await app.request(
        `/v1/households/${householdId}/chat/media/${encodeURIComponent(uploaded.mediaRef)}`,
        { headers },
      );
      assert.equal(before.status, 200);

      // Delete the message.
      const deleteRes = await app.request(
        `/v1/households/${householdId}/chat/messages/${sent.item.id}`,
        { method: 'DELETE', headers },
      );
      assert.equal(deleteRes.status, 200);
      const deleted = (await deleteRes.json()) as {
        item: { deletedAt: string | null; mediaRef: string | null };
      };
      assert.ok(deleted.item.deletedAt);
      assert.equal(deleted.item.mediaRef, null);

      // Media access is revoked after deletion — the mediaRef is gone from the
      // message and the store object is deleted.
      const after = await app.request(
        `/v1/households/${householdId}/chat/media/${encodeURIComponent(uploaded.mediaRef)}`,
        { headers },
      );
      assert.equal(after.status, 404);
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);

test(
  'editing a photo caption re-runs intent detection (ticket 06, AC#5)',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    const media = new InMemoryMediaStore();
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL), {
        media,
        transcription: new StubTranscriptionService(),
      });
      const suffix = crypto.randomUUID();
      const headers = devHeaders(suffix);
      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `Ticket 06 cap ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      const uploadRes = await app.request(`/v1/households/${householdId}/chat/media?kind=photo`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'image/jpeg' },
        body: Buffer.from('photo'),
      });
      const uploaded = (await uploadRes.json()) as { mediaRef: string };

      // Send a photo with no caption — no intent.
      const sendRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'photo', mediaRef: uploaded.mediaRef }),
      });
      const sent = (await sendRes.json()) as { item: { id: string } };

      // Edit the caption to a grocery phrase — intent re-runs.
      const editRes = await app.request(
        `/v1/households/${householdId}/chat/messages/${sent.item.id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ caption: 'नारियल चाहिए' }),
        },
      );
      assert.equal(editRes.status, 200);
      const edited = (await editRes.json()) as {
        item: { caption: string };
        intent: { kind: string; item?: string };
      };
      assert.equal(edited.item.caption, 'नारियल चाहिए');
      assert.equal(edited.intent.kind, 'grocery_request');
      if (edited.intent.kind === 'grocery_request') {
        assert.ok(edited.intent.item);
      }
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);
