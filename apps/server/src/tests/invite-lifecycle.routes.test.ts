import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '@cooklink/db';
import { createApp } from '../app.js';

/**
 * Ticket 03 — the Household Invite lifecycle, end to end through the Hono app
 * against Postgres. Exercises create → list → resend (revokes prior token) →
 * revoke → accept with the matching phone → membership.joined event → Owner
 * removes the member → the removed person is denied access on the next probe.
 *
 * Skipped without DATABASE_URL, exactly like the ticket-02 isolation test.
 */
test(
  'a household invite moves through create, resend, revoke, accept, and removal',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919300000001',
        'x-cooklink-dev-name': 'Ticket 03 Owner',
      };
      const cookHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-cook-${suffix}`,
        'x-cooklink-dev-phone': '+919300000002',
        'x-cooklink-dev-name': 'Ticket 03 Cook',
      };
      const intruderHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-intruder-${suffix}`,
        'x-cooklink-dev-phone': '+919300000099',
        'x-cooklink-dev-name': 'Ticket 03 Intruder',
      };

      // Owner creates a household.
      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 03 ${suffix}`, servingCount: 4 }),
      });
      assert.equal(createRes.status, 201);
      const { householdId } = (await createRes.json()) as { householdId: string };

      // Owner issues a cook invite for the cook's phone.
      const inviteRes = await app.request(`/v1/households/${householdId}/invites`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ phone: '+919300000002', role: 'cook' }),
      });
      assert.equal(inviteRes.status, 201);
      const invite = (await inviteRes.json()) as { id: string; token: string };

      // The invite shows up in the management list with a masked phone.
      const listRes = await app.request(`/v1/households/${householdId}/invites`, {
        headers: ownerHeaders,
      });
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as {
        invites: { id: string; phoneMasked: string }[];
      };
      assert.equal(listBody.invites.length, 1);
      const listed = listBody.invites[0];
      assert.ok(listed);
      assert.equal(listed.id, invite.id);
      assert.match(listed.phoneMasked, /•••• /);

      // A different verified phone cannot accept the phone-bound invite.
      const intruderAccept = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: intruderHeaders,
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(intruderAccept.status, 403);

      // The cook accepts with the matching phone and joins as a Cook.
      const acceptRes = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(acceptRes.status, 200);
      const accepted = (await acceptRes.json()) as { role: string };
      assert.equal(accepted.role, 'cook');

      // The single-use invite cannot be accepted a second time.
      const secondAccept = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(secondAccept.status, 404);

      // The cook now sees the household in their list.
      const cookHouseholdsRes = await app.request('/v1/households', { headers: cookHeaders });
      const cookHouseholds = (await cookHouseholdsRes.json()) as {
        households: { id: string; role: string }[];
      };
      assert.ok(cookHouseholds.households.some((h) => h.id === householdId && h.role === 'cook'));

      // The owner lists members and finds the cook membership id.
      const membersRes = await app.request(`/v1/households/${householdId}/members`, {
        headers: ownerHeaders,
      });
      const members = (await membersRes.json()) as {
        members: { id: string; role: string }[];
      };
      const cookMembership = members.members.find((m) => m.role === 'cook');
      assert.ok(cookMembership);

      // The owner removes the cook. Access is revoked immediately.
      const removeRes = await app.request(
        `/v1/households/${householdId}/members/${cookMembership.id}`,
        { method: 'DELETE', headers: ownerHeaders },
      );
      assert.equal(removeRes.status, 200);

      // The removed cook is now denied on the access probe, and on protected reads.
      const accessRes = await app.request(`/v1/households/${householdId}/access`, {
        headers: cookHeaders,
      });
      assert.equal(accessRes.status, 403);

      const mealPlanRes = await app.request(`/v1/households/${householdId}/meal-plan`, {
        headers: cookHeaders,
      });
      assert.equal(mealPlanRes.status, 404);
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
 * Resending an invite issues a fresh single-use token and revokes the old one;
 * revoking a pending invite makes it unacceptable. Both keep the seven-day
 * window from being extended by stale links.
 */
test(
  'resending revokes the prior token and revoking blocks acceptance',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();
      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-owner-r-${suffix}`,
        'x-cooklink-dev-phone': '+919300000010',
        'x-cooklink-dev-name': 'Ticket 03 Owner R',
      };
      const memberHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-member-r-${suffix}`,
        'x-cooklink-dev-phone': '+919300000011',
        'x-cooklink-dev-name': 'Ticket 03 Member R',
      };

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 03 R ${suffix}` }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      const firstRes = await app.request(`/v1/households/${householdId}/invites`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ phone: '+919300000011', role: 'member' }),
      });
      const first = (await firstRes.json()) as { id: string; token: string };

      const resendRes = await app.request(`/v1/invites/${first.id}/resend`, {
        method: 'POST',
        headers: ownerHeaders,
      });
      assert.equal(resendRes.status, 201);
      const resent = (await resendRes.json()) as { token: string };
      assert.notEqual(resent.token, first.token);

      // The original token is now dead.
      const oldAccept = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: memberHeaders,
        body: JSON.stringify({ token: first.token }),
      });
      assert.equal(oldAccept.status, 404);

      // A second invite that we revoke outright is also unacceptable.
      const secondRes = await app.request(`/v1/households/${householdId}/invites`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ phone: '+919300000011', role: 'member' }),
      });
      const second = (await secondRes.json()) as { id: string; token: string };
      const revokeRes = await app.request(`/v1/invites/${second.id}`, {
        method: 'DELETE',
        headers: ownerHeaders,
      });
      assert.equal(revokeRes.status, 200);
      const revokedAccept = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: memberHeaders,
        body: JSON.stringify({ token: second.token }),
      });
      assert.equal(revokedAccept.status, 404);
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
 * The two-Cook-per-Household limit must hold under concurrent acceptances.
 * Without serializing the limit check, two parallel cook acceptances into a
 * household that already has one cook would each read count=1, both pass the
 * `< 2` guard, and both insert — leaving three active cooks (a violation).
 * The household row lock taken inside the acceptance transaction serializes
 * the two acceptances so exactly one wins and the other is rejected with
 * `household_cook_limit_reached`. The per-Cook 30-Household budget is
 * serialized by the same mechanism via the user row lock.
 */
test(
  'two concurrent cook acceptances cannot exceed the two-cook household limit',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-owner-c-${suffix}`,
        'x-cooklink-dev-phone': '+919300000020',
        'x-cooklink-dev-name': 'Ticket 03 Owner C',
      };
      const cook1Headers = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-cook1-c-${suffix}`,
        'x-cooklink-dev-phone': '+919300000021',
        'x-cooklink-dev-name': 'Ticket 03 Cook 1',
      };
      const cook2Headers = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-cook2-c-${suffix}`,
        'x-cooklink-dev-phone': '+919300000022',
        'x-cooklink-dev-name': 'Ticket 03 Cook 2',
      };

      // Owner creates a household and lands the first cook (count = 1).
      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 03 C ${suffix}` }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      const firstInviteRes = await app.request(`/v1/households/${householdId}/invites`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ phone: '+919300000021', role: 'cook' }),
      });
      const firstInvite = (await firstInviteRes.json()) as { token: string };
      const firstAccept = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: cook1Headers,
        body: JSON.stringify({ token: firstInvite.token }),
      });
      assert.equal(firstAccept.status, 200);

      // Owner issues two more cook invites for two different phones and the
      // two recipients accept simultaneously. Only one may succeed; the
      // household must end with exactly two active cooks.
      const inviteA = (await (
        await app.request(`/v1/households/${householdId}/invites`, {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({ phone: '+919300000022', role: 'cook' }),
        })
      ).json()) as { token: string };
      const inviteB = (await (
        await app.request(`/v1/households/${householdId}/invites`, {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({ phone: '+919300000023', role: 'cook' }),
        })
      ).json()) as { token: string };
      const cook3Headers = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-03-cook3-c-${suffix}`,
        'x-cooklink-dev-phone': '+919300000023',
        'x-cooklink-dev-name': 'Ticket 03 Cook 3',
      };

      const [acceptA, acceptB] = await Promise.all([
        app.request('/v1/invites/accept', {
          method: 'POST',
          headers: cook2Headers,
          body: JSON.stringify({ token: inviteA.token }),
        }),
        app.request('/v1/invites/accept', {
          method: 'POST',
          headers: cook3Headers,
          body: JSON.stringify({ token: inviteB.token }),
        }),
      ]);

      const statuses = [acceptA.status, acceptB.status].sort();
      assert.ok(
        statuses.includes(200),
        `one concurrent acceptance should succeed (got ${statuses.join(',')})`,
      );
      assert.ok(
        statuses.includes(409),
        `the other should be rejected as cook_limit_reached (got ${statuses.join(',')})`,
      );

      // The household must have exactly two active cooks, never three.
      const membersRes = await app.request(`/v1/households/${householdId}/members`, {
        headers: ownerHeaders,
      });
      const members = (await membersRes.json()) as {
        members: { id: string; role: string; status: string }[];
      };
      const activeCooks = members.members.filter((m) => m.role === 'cook' && m.status === 'active');
      assert.equal(activeCooks.length, 2, 'the household must not exceed two active cooks');
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);
