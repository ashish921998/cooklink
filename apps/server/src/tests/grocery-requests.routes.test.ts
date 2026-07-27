import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '@cooklink/db';
import { createApp } from '../app.js';

/**
 * Ticket 08 — turn Cook messages into Member-approved Grocery Requests, end to
 * end through the Hono app against MySQL. Exercises: a Cook's Hindi grocery
 * text produces a private suggestion; confirming creates a pending Grocery
 * Request and an attributed Chat event; a bare "I need grocery" asks one plain
 * follow-up question; a similar pending request surfaces Update quantity / Keep
 * separate; either Cook may update or cancel a pending request but not after
 * Member approval; a Member approves, rejects, or "order now" (which never
 * places an order); a Cook cannot resolve; a Member's grocery intent adds to
 * the Suggested Grocery Cart for review.
 *
 * Skipped without DATABASE_URL, exactly like the other MySQL app tests.
 */
test(
  'cook messages become member-approved grocery requests through the server',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for MySQL app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const db = createDatabase(process.env.DATABASE_URL);
      const app = createApp(db);
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-08-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919600000001',
        'x-cooklink-dev-name': 'Ticket 08 Owner',
      };
      const cookHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-08-cook-${suffix}`,
        'x-cooklink-dev-phone': '+919600000002',
        'x-cooklink-dev-name': 'Ticket 08 Cook',
      };

      // Owner creates a household and invites a Cook.
      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 08 ${suffix}`, servingCount: 4 }),
      });
      assert.equal(createRes.status, 201);
      const { householdId } = (await createRes.json()) as { householdId: string };

      const inviteRes = await app.request(`/v1/households/${householdId}/invites`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ phone: '+919600000002', role: 'cook' }),
      });
      assert.equal(inviteRes.status, 201);
      const invite = (await inviteRes.json()) as { token: string };
      const acceptRes = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(acceptRes.status, 200);

      // AC#1 — a Hindi grocery message produces a private grocery_request
      // suggestion for the Cook (no Instamart product or urgency required).
      const sendRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ kind: 'text', body: 'नारियल चाहिए' }),
      });
      assert.equal(sendRes.status, 201);
      const sent = (await sendRes.json()) as {
        intent: { kind: string; item: string };
        suggestion: { id: string; status: string } | null;
      };
      assert.equal(sent.intent.kind, 'grocery_request');
      assert.equal(sent.intent.item, 'नारियल');
      assert.ok(sent.suggestion);

      // AC#3 — a non-author member cannot confirm the Cook's private suggestion.
      const wrongConfirm = await app.request(
        `/v1/households/${householdId}/chat/suggestions/${sent.suggestion!.id}/confirm`,
        { method: 'POST', headers: ownerHeaders, body: JSON.stringify({}) },
      );
      assert.equal(wrongConfirm.status, 404);

      // AC#4 — the Cook confirms; a pending Grocery Request is created and an
      // attributed event appears in Chat.
      const confirmRes = await app.request(
        `/v1/households/${householdId}/chat/suggestions/${sent.suggestion!.id}/confirm`,
        { method: 'POST', headers: cookHeaders, body: JSON.stringify({}) },
      );
      assert.equal(confirmRes.status, 201);
      const confirmed = (await confirmRes.json()) as {
        request: { id: string; itemText: string; status: string; version: number };
      };
      assert.equal(confirmed.request.itemText, 'नारियल');
      assert.equal(confirmed.request.status, 'pending');

      const chatRes = await app.request(`/v1/households/${householdId}/chat`, {
        headers: cookHeaders,
      });
      const chat = (await chatRes.json()) as {
        items: { kind: string; type?: string; text?: string }[];
      };
      const createdEvent = chat.items.find(
        (i) => i.kind === 'event' && i.type === 'grocery_request.created',
      );
      assert.ok(createdEvent, 'grocery_request.created event is attributed in Chat');

      // The Owner sees the pending request in the shared queue (AC#7).
      const listRes = await app.request(`/v1/households/${householdId}/grocery-requests`, {
        headers: ownerHeaders,
      });
      assert.equal(listRes.status, 200);
      const list = (await listRes.json()) as {
        requests: { id: string; status: string; itemText: string }[];
      };
      assert.equal(list.requests.length, 1);
      assert.equal(list.requests[0]!.status, 'pending');

      // AC#2 — a bare "I need grocery" asks one plain follow-up question.
      const vagueRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ kind: 'text', body: 'I need grocery' }),
      });
      const vague = (await vagueRes.json()) as {
        intent: { kind: string; item: string };
        suggestion: { id: string } | null;
      };
      assert.equal(vague.intent.kind, 'grocery_request');
      assert.equal(vague.intent.item, '');
      const vagueConfirm = await app.request(
        `/v1/households/${householdId}/chat/suggestions/${vague.suggestion!.id}/confirm`,
        { method: 'POST', headers: cookHeaders, body: JSON.stringify({}) },
      );
      assert.equal(vagueConfirm.status, 422);
      const vagueBody = (await vagueConfirm.json()) as { error: string; followUp: string };
      assert.equal(vagueBody.error, 'missing_item');
      assert.ok(vagueBody.followUp);

      // AC#5 — a similar pending request surfaces Update quantity / Keep
      // separate rather than emitting a duplicate.
      const similarRes = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ kind: 'text', body: 'नारियल चाहिए' }),
      });
      const similarMsg = (await similarRes.json()) as { suggestion: { id: string } | null };
      const similarConfirm = await app.request(
        `/v1/households/${householdId}/chat/suggestions/${similarMsg.suggestion!.id}/confirm`,
        { method: 'POST', headers: cookHeaders, body: JSON.stringify({}) },
      );
      assert.equal(similarConfirm.status, 409);
      const similarBody = (await similarConfirm.json()) as {
        error: string;
        similar: { id: string };
      };
      assert.equal(similarBody.error, 'similar_exists');
      assert.equal(similarBody.similar.id, confirmed.request.id);

      // AC#6 — either Cook may update a pending request; version bumps.
      const updateRes = await app.request(
        `/v1/households/${householdId}/grocery-requests/${confirmed.request.id}`,
        {
          method: 'PATCH',
          headers: cookHeaders,
          body: JSON.stringify({ expectedVersion: confirmed.request.version, quantityText: '2' }),
        },
      );
      assert.equal(updateRes.status, 200);
      const updated = (await updateRes.json()) as {
        request: { version: number; quantityText: string };
      };
      assert.equal(updated.request.version, confirmed.request.version + 1);
      assert.equal(updated.request.quantityText, '2');

      // AC#8 — a Cook cannot resolve (approve/reject) a request.
      const cookResolve = await app.request(
        `/v1/households/${householdId}/grocery-requests/${confirmed.request.id}/resolve`,
        {
          method: 'POST',
          headers: cookHeaders,
          body: JSON.stringify({ expectedVersion: updated.request.version, resolution: 'approve' }),
        },
      );
      // The cook lacks approve_reject_request; authorization denial → 404.
      assert.equal(cookResolve.status, 404);

      // AC#7/AC#8 — the Owner "order now" approves for the next cart but
      // never places an order.
      const orderNowRes = await app.request(
        `/v1/households/${householdId}/grocery-requests/${confirmed.request.id}/resolve`,
        {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({
            expectedVersion: updated.request.version,
            resolution: 'order_now',
          }),
        },
      );
      assert.equal(orderNowRes.status, 200);
      const orderNow = (await orderNowRes.json()) as {
        request: { status: string };
        orderNow: boolean;
      };
      assert.equal(orderNow.request.status, 'approved');
      assert.equal(orderNow.orderNow, true);

      // AC#6 — after Member approval, a Cook can no longer edit the request.
      // The conflict response surfaces the actor who changed it (issue 06).
      const cookEditAfter = await app.request(
        `/v1/households/${householdId}/grocery-requests/${confirmed.request.id}`,
        {
          method: 'PATCH',
          headers: cookHeaders,
          body: JSON.stringify({ expectedVersion: updated.request.version, quantityText: '5' }),
        },
      );
      assert.equal(cookEditAfter.status, 422);
      const lockedBody = (await cookEditAfter.json()) as {
        error: string;
        changedBy: { displayName: string; role: string } | null;
      };
      assert.equal(lockedBody.error, 'locked_after_approval');
      assert.ok(lockedBody.changedBy, 'the actor who changed the request is surfaced');
      assert.equal(lockedBody.changedBy!.role, 'owner');

      // AC#7 — a Member may reject a different pending request. Create one
      // more, then reject it.
      const secondSend = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ kind: 'text', body: 'प्याज चाहिए' }),
      });
      const secondMsg = (await secondSend.json()) as { suggestion: { id: string } | null };
      const secondConfirm = await app.request(
        `/v1/households/${householdId}/chat/suggestions/${secondMsg.suggestion!.id}/confirm`,
        { method: 'POST', headers: cookHeaders, body: JSON.stringify({}) },
      );
      const secondReq = (await secondConfirm.json()) as {
        request: { id: string; version: number };
      };
      const rejectRes = await app.request(
        `/v1/households/${householdId}/grocery-requests/${secondReq.request.id}/resolve`,
        {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({
            expectedVersion: secondReq.request.version,
            resolution: 'reject',
          }),
        },
      );
      assert.equal(rejectRes.status, 200);
      const rejected = (await rejectRes.json()) as { request: { status: string } };
      assert.equal(rejected.request.status, 'rejected');

      // AC#8 — a Cook cannot cancel an approved request.
      const cookCancelAfter = await app.request(
        `/v1/households/${householdId}/grocery-requests/${confirmed.request.id}`,
        {
          method: 'PATCH',
          headers: cookHeaders,
          body: JSON.stringify({ expectedVersion: updated.request.version, status: 'cancelled' }),
        },
      );
      assert.equal(cookCancelAfter.status, 422);

      // AC#3 — the author may dismiss a private suggestion.
      const dismissSend = await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ kind: 'text', body: 'हल्दी चाहिए' }),
      });
      const dismissMsg = (await dismissSend.json()) as { suggestion: { id: string } | null };
      const dismissRes = await app.request(
        `/v1/households/${householdId}/chat/suggestions/${dismissMsg.suggestion!.id}/dismiss`,
        { method: 'POST', headers: cookHeaders, body: JSON.stringify({}) },
      );
      assert.equal(dismissRes.status, 200);
    } finally {
      process.env.COOKLINK_DEV_AUTH = previousDevAuth;
    }
  },
);
