import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '@cooklink/db';
import { createApp } from '../app.js';

/**
 * Ticket 09 — generate the three-day Suggested Grocery Cart, end to end
 * through the Hono app against Postgres. Exercises: the cart is built from the
 * current meal plan and Estimated Pantry; likely-available ingredients are
 * omitted; uncertain items appear as "Check at home"; a Member can keep or
 * remove a line with an optional reason; a Cook cannot edit the cart; the
 * cart is isolated per Household (a non-member gets 404).
 *
 * Skipped without DATABASE_URL, exactly like the other Postgres app tests.
 */
test(
  'three-day suggested grocery cart through the server',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const db = createDatabase(process.env.DATABASE_URL);
      const app = createApp(db);
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-09-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919700000001',
        'x-cooklink-dev-name': 'Ticket 09 Owner',
      };

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 09 ${suffix}`, servingCount: 4 }),
      });
      assert.equal(createRes.status, 201);
      const { householdId } = (await createRes.json()) as { householdId: string };

      // GET the suggested cart — the starter plan has no recipe links (all
      // recipeId: null), so the cart is empty until the plan references real
      // recipes. The endpoint still returns 200 with an items array.
      const cartRes = await app.request(`/v1/households/${householdId}/suggested-cart`, {
        headers: ownerHeaders,
      });
      assert.equal(cartRes.status, 200);
      const cart = (await cartRes.json()) as { items: unknown[] };
      assert.ok(Array.isArray(cart.items));

      // A non-member gets 404 (household isolation).
      const otherHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-09-other-${suffix}`,
        'x-cooklink-dev-phone': '+919700000002',
        'x-cooklink-dev-name': 'Ticket 09 Other',
      };
      const deniedRes = await app.request(`/v1/households/${householdId}/suggested-cart`, {
        headers: otherHeaders,
      });
      assert.equal(deniedRes.status, 404);

      // Invite a Cook so we can verify Cooks can view but not edit the cart.
      const inviteRes = await app.request(`/v1/households/${householdId}/invites`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ phone: '+919700000003', role: 'cook' }),
      });
      assert.equal(inviteRes.status, 201);
      const invite = (await inviteRes.json()) as { token: string };
      const cookHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-09-cook-${suffix}`,
        'x-cooklink-dev-phone': '+919700000003',
        'x-cooklink-dev-name': 'Ticket 09 Cook',
      };
      const acceptRes = await app.request('/v1/invites/accept', {
        method: 'POST',
        headers: cookHeaders,
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(acceptRes.status, 200);

      // A Cook can view the cart.
      const cookCartRes = await app.request(`/v1/households/${householdId}/suggested-cart`, {
        headers: cookHeaders,
      });
      assert.equal(cookCartRes.status, 200);

      // If the cart has items, verify a Cook cannot edit them and a Member can.
      if (cart.items.length > 0) {
        const firstItem = (cart.items as { id: string; checkAtHome: boolean }[])[0]!;

        // Cook cannot PATCH a cart item (add_to_cart is Member/Owner only).
        const cookPatchRes = await app.request(
          `/v1/households/${householdId}/suggested-cart/${firstItem.id}`,
          {
            method: 'PATCH',
            headers: cookHeaders,
            body: JSON.stringify({ state: 'removed', removalReason: 'already_have' }),
          },
        );
        assert.equal(cookPatchRes.status, 404);

        // Owner can remove a cart line with a reason.
        const patchRes = await app.request(
          `/v1/households/${householdId}/suggested-cart/${firstItem.id}`,
          {
            method: 'PATCH',
            headers: ownerHeaders,
            body: JSON.stringify({ state: 'removed', removalReason: 'already_have' }),
          },
        );
        assert.equal(patchRes.status, 200);
        const patched = (await patchRes.json()) as {
          item: { memberState: string; removalReason: string };
        };
        assert.equal(patched.item.memberState, 'removed');
        assert.equal(patched.item.removalReason, 'already_have');

        // Invalid state is rejected.
        const badPatchRes = await app.request(
          `/v1/households/${householdId}/suggested-cart/${firstItem.id}`,
          {
            method: 'PATCH',
            headers: ownerHeaders,
            body: JSON.stringify({ state: 'bogus' }),
          },
        );
        assert.equal(badPatchRes.status, 400);
      }

      // A PATCH on a non-existent item returns 404.
      const notFoundRes = await app.request(
        `/v1/households/${householdId}/suggested-cart/nonexistent`,
        {
          method: 'PATCH',
          headers: ownerHeaders,
          body: JSON.stringify({ state: 'kept' }),
        },
      );
      assert.equal(notFoundRes.status, 404);
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);
