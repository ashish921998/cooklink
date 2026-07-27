import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDatabase } from '@cooklink/db';
import { createApp } from '../app.js';

test('health route is public JSON', async () => {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, service: 'cooklink-server' }));

  const res = await app.request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'cooklink-server' });
});

test(
  'new household starter plan is inaccessible to another authenticated person',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for MySQL app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();
      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-02-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919200000001',
        'x-cooklink-dev-name': 'Ticket Owner',
      };
      const otherHeaders = {
        'x-clerk-user-id': `ticket-02-other-${suffix}`,
        'x-cooklink-dev-phone': '+919200000002',
        'x-cooklink-dev-name': 'Ticket Other',
      };

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          name: `Ticket 02 ${suffix}`,
          servingCount: 4,
          mealStyle: 'north',
          dietStyle: 'vegetarian',
        }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as { householdId: string; mealCount: number };
      assert.equal(created.mealCount, 21);

      const ownerPlanRes = await app.request(`/v1/households/${created.householdId}/meal-plan`, {
        headers: ownerHeaders,
      });
      assert.equal(ownerPlanRes.status, 200);
      const ownerPlan = (await ownerPlanRes.json()) as { meals: unknown[] };
      assert.equal(ownerPlan.meals.length, 21);

      const otherPlanRes = await app.request(`/v1/households/${created.householdId}/meal-plan`, {
        headers: otherHeaders,
      });
      assert.equal(otherPlanRes.status, 404);
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);
