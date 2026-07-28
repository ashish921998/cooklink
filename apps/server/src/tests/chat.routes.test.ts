import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '@cooklink/db';
import { createApp } from '../app.js';

/**
 * Ticket 04 — Household text Chat, end to end through the Hono app against
 * Postgres. Exercises: the access probe returns the caller's membershipId; an
 * authenticated non-member is denied the timeline; an active member sends a
 * text message, sees it attributed in server order, edits it, deletes it
 * (tombstone), marks read, and polls for newer items via the forward cursor.
 *
 * Skipped without DATABASE_URL, exactly like the ticket-02/03 Postgres tests.
 */
test(
  'household text chat lifecycle through the server',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-04-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919400000001',
        'x-cooklink-dev-name': 'Meera',
      };
      const intruderHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-04-intruder-${suffix}`,
        'x-cooklink-dev-phone': '+919400000099',
        'x-cooklink-dev-name': 'Intruder',
      };

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 04 ${suffix}`, servingCount: 4 }),
      });
      assert.equal(createRes.status, 201);
      const { householdId } = (await createRes.json()) as { householdId: string };

      // The access probe hands the caller its own membershipId for attribution.
      const accessRes = await app.request(`/v1/households/${householdId}/access`, {
        headers: ownerHeaders,
      });
      assert.equal(accessRes.status, 200);
      const access = (await accessRes.json()) as { ok: boolean; membershipId: string };
      assert.equal(access.ok, true);
      assert.ok(access.membershipId);

      // An authenticated non-member is denied the timeline (issue 06, AC#22).
      const intruderTimeline = await app.request(`/v1/households/${householdId}/chat`, {
        headers: intruderHeaders,
      });
      assert.equal(intruderTimeline.status, 404);

      // The owner sends a text message.
      const sendRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ kind: 'text', body: 'dinner at 8' }),
      });
      assert.equal(sendRes.status, 201);
      const sent = (await sendRes.json()) as {
        membershipId: string;
        item: { id: string; body: string; senderId: string; kind: 'message' };
      };
      assert.equal(sent.item.body, 'dinner at 8');
      assert.equal(sent.membershipId, sent.item.senderId);

      // The timeline shows the message, attributed to its sender.
      const timelineRes = await app.request(`/v1/households/${householdId}/chat`, {
        headers: ownerHeaders,
      });
      assert.equal(timelineRes.status, 200);
      const timeline = (await timelineRes.json()) as {
        items: { kind: string; body?: string; sender?: { displayName: string } }[];
      };
      assert.equal(timeline.items.length, 1);
      assert.equal(timeline.items[0]!.body, 'dinner at 8');
      assert.equal(timeline.items[0]!.sender!.displayName, 'Meera');

      // Editing the message within the window updates the body and marks it edited.
      const editRes = await app.request(
        `/v1/households/${householdId}/chat/messages/${sent.item.id}`,
        {
          method: 'PATCH',
          headers: ownerHeaders,
          body: JSON.stringify({ body: 'dinner at 8:30' }),
        },
      );
      assert.equal(editRes.status, 200);
      const edited = (await editRes.json()) as { item: { body: string; editedAt: string | null } };
      assert.equal(edited.item.body, 'dinner at 8:30');
      assert.ok(edited.item.editedAt);

      // Deleting the message leaves a tombstone (no body, deletedAt set).
      const deleteRes = await app.request(
        `/v1/households/${householdId}/chat/messages/${sent.item.id}`,
        { method: 'DELETE', headers: ownerHeaders },
      );
      assert.equal(deleteRes.status, 200);
      const deleted = (await deleteRes.json()) as {
        item: { body: string | null; deletedAt: string | null };
      };
      assert.equal(deleted.item.body, null);
      assert.ok(deleted.item.deletedAt);

      // The tombstone remains in the timeline.
      const timelineAfter = (await (
        await app.request(`/v1/households/${householdId}/chat`, { headers: ownerHeaders })
      ).json()) as { items: { kind: string; deletedAt: string | null }[] };
      assert.equal(timelineAfter.items.length, 1);
      assert.ok(timelineAfter.items[0]!.deletedAt);

      // Marking read persists the private last-read position.
      const readRes = await app.request(`/v1/households/${householdId}/chat/read`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ lastReadMessageId: sent.item.id }),
      });
      assert.equal(readRes.status, 200);

      // A new message arrives; the forward cursor returns exactly it.
      const second = (await (
        await app.request(`/v1/households/${householdId}/chat/messages`, {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({ kind: 'text', body: 'second' }),
        })
      ).json()) as { item: { id: string } };
      const delta = (await (
        await app.request(`/v1/households/${householdId}/chat?afterId=${sent.item.id}`, {
          headers: ownerHeaders,
        })
      ).json()) as { items: { id: string; body?: string }[] };
      assert.equal(delta.items.length, 1);
      assert.equal(delta.items[0]!.id, second.item.id);
      assert.equal(delta.items[0]!.body, 'second');
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);

/**
 * Checklist item 7 — authorization tests cover cross-Household denial and
 * non-author mutation. A member of Household A must not read or mutate
 * Household B's chat; a Cook must not edit or delete another Cook's message.
 * Skipped without DATABASE_URL, like the lifecycle test above.
 */
test(
  'chat is household-scoped and own-message only',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();

      const ownerAHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-04-ownerA-${suffix}`,
        'x-cooklink-dev-phone': '+919400000010',
        'x-cooklink-dev-name': 'Owner A',
      };
      const ownerBHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-04-ownerB-${suffix}`,
        'x-cooklink-dev-phone': '+919400000020',
        'x-cooklink-dev-name': 'Owner B',
      };

      // Two unrelated households, each owned by a different person.
      const createA = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerAHeaders,
        body: JSON.stringify({ name: `A ${suffix}`, servingCount: 4 }),
      });
      const { householdId: householdA } = (await createA.json()) as { householdId: string };
      const createB = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerBHeaders,
        body: JSON.stringify({ name: `B ${suffix}`, servingCount: 4 }),
      });
      const { householdId: householdB } = (await createB.json()) as { householdId: string };

      // Owner A sends a message in their own Household.
      const sendRes = await app.request(`/v1/households/${householdA}/chat/messages`, {
        method: 'POST',
        headers: ownerAHeaders,
        body: JSON.stringify({ kind: 'text', body: 'secret-for-A' }),
      });
      assert.equal(sendRes.status, 201);
      const sent = (await sendRes.json()) as { item: { id: string } };

      // Cross-Household denial: Owner B cannot read A's timeline (issue 06,
      // AC#22 — a membership cannot read another Household's chat).
      const bReadsA = await app.request(`/v1/households/${householdA}/chat`, {
        headers: ownerBHeaders,
      });
      assert.equal(bReadsA.status, 404);

      // Cross-Household denial: Owner B cannot edit or delete A's message even
      // if they somehow know its id.
      const bEditsA = await app.request(
        `/v1/households/${householdA}/chat/messages/${sent.item.id}`,
        {
          method: 'PATCH',
          headers: ownerBHeaders,
          body: JSON.stringify({ body: 'hacked' }),
        },
      );
      assert.equal(bEditsA.status, 404);

      // Non-author denial within the same Household: Owner B is not a member of
      // A at all (covered above), so exercise the non-author path with two
      // members of the SAME Household. Owner A invites Owner B's phone as a
      // member of A; B accepts; A's message cannot be edited by B.
      const inviteRes = await app.request(`/v1/households/${householdA}/invites`, {
        method: 'POST',
        headers: ownerAHeaders,
        body: JSON.stringify({ phone: '+919400000020', role: 'member' }),
      });
      assert.equal(inviteRes.status, 201);
      const invite = (await inviteRes.json()) as { token: string };
      const acceptRes = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: ownerBHeaders,
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(acceptRes.status, 200);

      // B can now READ A's timeline (they are a member) ...
      const bReadsAAfter = await app.request(`/v1/households/${householdA}/chat`, {
        headers: ownerBHeaders,
      });
      assert.equal(bReadsAAfter.status, 200);

      // ... but cannot edit or delete A's message (not the author; issue 06,
      // AC#11 — only the author may mutate, within the window).
      const bEditsOwnedByA = await app.request(
        `/v1/households/${householdA}/chat/messages/${sent.item.id}`,
        {
          method: 'PATCH',
          headers: ownerBHeaders,
          body: JSON.stringify({ body: 'hacked' }),
        },
      );
      assert.equal(bEditsOwnedByA.status, 403);
      const bDeletesOwnedByA = await app.request(
        `/v1/households/${householdA}/chat/messages/${sent.item.id}`,
        { method: 'DELETE', headers: ownerBHeaders },
      );
      assert.equal(bDeletesOwnedByA.status, 403);
      void householdB;
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);
