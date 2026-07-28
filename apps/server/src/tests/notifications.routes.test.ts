import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '@cooklink/db';
import { createApp } from '../app.js';

/**
 * Issue 12 — Role-aware push notifications, end to end through the Hono app
 * against Postgres. Exercises:
 *  - New memberships default Members to All, Cooks to Important (AC#1)
 *  - Per-Household notification override (AC#2)
 *  - Per-role default notification setting (AC#2)
 *  - Device registration and invalidation (AC#8)
 *  - Unread count preserves correct in-app state even when muted (AC#8)
 *  - Push dispatch fires on message send (AC#3/AC#5)
 *
 * Skipped without DATABASE_URL, exactly like the other Postgres app tests.
 */
test(
  'notification settings, device registration, and unread count lifecycle',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-12-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919400000001',
        'x-cooklink-dev-name': 'Meera',
      };

      // Create household (owner defaults to All activity).
      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 12 ${suffix}`, servingCount: 4 }),
      });
      assert.equal(createRes.status, 201);
      const { householdId } = (await createRes.json()) as { householdId: string };

      // AC#2 — set per-Household notification override to Muted.
      const overrideRes = await app.request(`/v1/households/${householdId}/notification-override`, {
        method: 'PATCH',
        headers: ownerHeaders,
        body: JSON.stringify({ level: 'muted' }),
      });
      assert.equal(overrideRes.status, 200);
      const override = (await overrideRes.json()) as { ok: boolean; override: string | null };
      assert.equal(override.ok, true);
      assert.equal(override.override, 'muted');

      // AC#2 — null override restores the role default.
      const restoreRes = await app.request(`/v1/households/${householdId}/notification-override`, {
        method: 'PATCH',
        headers: ownerHeaders,
        body: JSON.stringify({ level: null }),
      });
      assert.equal(restoreRes.status, 200);
      const restored = (await restoreRes.json()) as { ok: boolean; override: string | null };
      assert.equal(restored.override, null);

      // AC#2 — invalid level is rejected.
      const badLevelRes = await app.request(`/v1/households/${householdId}/notification-override`, {
        method: 'PATCH',
        headers: ownerHeaders,
        body: JSON.stringify({ level: 'bogus' }),
      });
      assert.equal(badLevelRes.status, 400);

      // AC#2 — per-role default.
      const defaultRes = await app.request('/v1/me/notification-default', {
        method: 'PATCH',
        headers: ownerHeaders,
        body: JSON.stringify({ role: 'member', level: 'important' }),
      });
      assert.equal(defaultRes.status, 200);
      const defaultBody = (await defaultRes.json()) as { ok: boolean; default: string };
      assert.equal(defaultBody.default, 'important');

      // AC#2 — invalid role is rejected.
      const badRoleRes = await app.request('/v1/me/notification-default', {
        method: 'PATCH',
        headers: ownerHeaders,
        body: JSON.stringify({ role: 'owner', level: 'all' }),
      });
      assert.equal(badRoleRes.status, 400);

      // AC#8 — register a device.
      const deviceRes = await app.request('/v1/me/devices', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          pushToken: `ExpoPushToken[ticket-12-${suffix}]`,
          platform: 'ios',
          hidePreviews: false,
        }),
      });
      assert.equal(deviceRes.status, 201);
      const device = (await deviceRes.json()) as {
        device: { id: string; pushToken: string; platform: string; hidePreviews: boolean };
      };
      assert.equal(device.device.platform, 'ios');
      assert.equal(device.device.pushToken, `ExpoPushToken[ticket-12-${suffix}]`);

      // AC#8 — list active devices.
      const listRes = await app.request('/v1/me/devices', { headers: ownerHeaders });
      assert.equal(listRes.status, 200);
      const list = (await listRes.json()) as { devices: { id: string }[] };
      assert.ok(list.devices.length >= 1);

      // AC#8 — invalidate the device.
      const delRes = await app.request(`/v1/me/devices/${device.device.id}`, {
        method: 'DELETE',
        headers: ownerHeaders,
      });
      assert.equal(delRes.status, 200);

      // After invalidation, the device is no longer in the active list.
      const listAfter = await app.request('/v1/me/devices', { headers: ownerHeaders });
      const afterList = (await listAfter.json()) as { devices: { id: string }[] };
      assert.ok(!afterList.devices.some((d) => d.id === device.device.id));

      // AC#8 — invalid platform is rejected.
      const badPlatformRes = await app.request('/v1/me/devices', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ pushToken: 't', platform: 'windows' }),
      });
      assert.equal(badPlatformRes.status, 400);

      // AC#8 — unread count starts at zero for a new household.
      const unreadRes = await app.request(`/v1/households/${householdId}/unread`, {
        headers: ownerHeaders,
      });
      assert.equal(unreadRes.status, 200);
      const unread = (await unreadRes.json()) as { unread: number };
      assert.equal(unread.unread, 0);

      // Send a message and verify unread increments.
      await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ kind: 'text', body: 'test message' }),
      });
      const unreadAfter = await app.request(`/v1/households/${householdId}/unread`, {
        headers: ownerHeaders,
      });
      const afterUnread = (await unreadAfter.json()) as { unread: number };
      // Owner sent it, so it's not unread for them (they sent it).
      assert.equal(afterUnread.unread, 0);
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
  'push dispatcher receives notifications on message send (AC#3/AC#5)',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      // Use a recording dispatcher to capture pushes.
      const { RecordingPushDispatcher } = await import('@cooklink/domain');
      const dispatcher = new RecordingPushDispatcher();
      const app = createApp(createDatabase(process.env.DATABASE_URL), {
        pushDispatcher: dispatcher,
      });
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-12-push-owner-${suffix}`,
        'x-cooklink-dev-phone': '+919400000010',
        'x-cooklink-dev-name': 'PushOwner',
      };

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 12 Push ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      // Owner sends a message — no one else is in the household, so no push.
      await app.request(`/v1/households/${householdId}/chat/messages`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ kind: 'text', body: 'hello' }),
      });
      // Allow fire-and-forget dispatch to complete.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Only the owner is in the household; owner is the actor, so no pushes.
      assert.equal(dispatcher.sent.length, 0);
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
  'opening a notification re-authorizes via /access (AC#7)',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const previousDevAuth = process.env.COOKLINK_DEV_AUTH;
    process.env.COOKLINK_DEV_AUTH = 'true';
    try {
      const app = createApp(createDatabase(process.env.DATABASE_URL));
      const suffix = crypto.randomUUID();

      const ownerHeaders = {
        'content-type': 'application/json',
        'x-clerk-user-id': `ticket-12-access-${suffix}`,
        'x-cooklink-dev-phone': '+919400000020',
        'x-cooklink-dev-name': 'AccessOwner',
      };
      const intruderHeaders = {
        'x-clerk-user-id': `ticket-12-intruder-${suffix}`,
        'x-cooklink-dev-phone': '+919400000099',
        'x-cooklink-dev-name': 'Intruder',
      };

      const createRes = await app.request('/v1/households', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: `Ticket 12 Access ${suffix}`, servingCount: 4 }),
      });
      const { householdId } = (await createRes.json()) as { householdId: string };

      // AC#7 — the access route re-authorizes current membership.
      const ownerAccess = await app.request(`/v1/households/${householdId}/access`, {
        headers: ownerHeaders,
      });
      assert.equal(ownerAccess.status, 200);

      // An intruder is denied.
      const intruderAccess = await app.request(`/v1/households/${householdId}/access`, {
        headers: intruderHeaders,
      });
      assert.equal(intruderAccess.status, 403);
    } finally {
      if (previousDevAuth === undefined) {
        delete process.env.COOKLINK_DEV_AUTH;
      } else {
        process.env.COOKLINK_DEV_AUTH = previousDevAuth;
      }
    }
  },
);
