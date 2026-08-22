/**
 * Notification and device API routes (issue 12).
 *
 * Role-aware push notifications: each person configures a per-role default and
 * may override a Household with All activity, Important only, or Muted.
 * Device tokens are registered for push delivery and retired when the
 * provider reports them invalid. The in-app unread count is independent of
 * the push level so a muted person still sees the correct badge.
 */
import { randomUUID } from 'node:crypto';
import { and, count, eq, gt, isNull } from 'drizzle-orm';
import type { Hono } from 'hono';
import { brandId, type NotificationLevel } from '@cooklink/domain';
import { chatMessages, deviceRegistrations, householdMemberState, memberships } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import type { AppRouteContext } from './route-context.js';

/** Mount the notification routes: role defaults, household overrides, devices, unread. */
export function registerNotificationRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization } = ctx;

  /**
   * Set the per-role notification default for the current user (issue 12,
   * AC#2). The default applies to every Household where the user holds that
   * role unless overridden per-Household.
   */
  app.patch('/v1/me/notification-default', async (c) => {
    const user = c.get('authUser');
    const body: { role?: 'member' | 'cook'; level?: NotificationLevel } = await c.req
      .json()
      .catch(() => ({}));
    if (body.role !== 'member' && body.role !== 'cook') {
      return c.json({ error: 'invalid_role' }, 400);
    }
    if (body.level !== 'all' && body.level !== 'important' && body.level !== 'muted') {
      return c.json({ error: 'invalid_level' }, 400);
    }
    // Update all active memberships where this user holds the given role.
    await db
      .update(memberships)
      .set({ notificationDefault: body.level })
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.role, body.role),
          eq(memberships.status, 'active'),
        ),
      );
    return c.json({ ok: true, role: body.role, default: body.level });
  });

  /**
   * Set a per-Household notification override for the current user (issue 12,
   * AC#2). The override wins over the role default. A null override restores
   * the default.
   */
  app.patch('/v1/households/:householdId/notification-override', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'configure_notifications',
    );
    const body: { level?: NotificationLevel | null } = await c.req.json().catch(() => ({}));
    const level = body.level ?? null;
    if (level !== null && level !== 'all' && level !== 'important' && level !== 'muted') {
      return c.json({ error: 'invalid_level' }, 400);
    }
    await db
      .insert(householdMemberState)
      .values({
        userId: principal.userId,
        householdId: principal.householdId,
        notificationOverride: level,
      })
      .onConflictDoUpdate({
        target: [householdMemberState.userId, householdMemberState.householdId],
        set: { notificationOverride: level },
      });
    return c.json({ ok: true, override: level });
  });

  /**
   * Register a device for push notifications (issue 12). The push token is
   * unique per device; re-registering updates the platform and preview
   * settings. The `hidePreviews` flag produces generic notification text only
   * (AC#6 — previews are redacted per device setting; money is always
   * redacted regardless).
   */
  app.post('/v1/me/devices', async (c) => {
    const user = c.get('authUser');
    const body: {
      pushToken?: string;
      platform?: 'ios' | 'android';
      hidePreviews?: boolean;
    } = await c.req.json().catch(() => ({}));
    if (!body.pushToken || typeof body.pushToken !== 'string') {
      return c.json({ error: 'push_token_required' }, 400);
    }
    if (body.platform !== 'ios' && body.platform !== 'android') {
      return c.json({ error: 'invalid_platform' }, 400);
    }
    await db
      .insert(deviceRegistrations)
      .values({
        id: randomUUID(),
        userId: user.id,
        pushToken: body.pushToken,
        platform: body.platform,
        hidePreviews: body.hidePreviews ?? false,
        invalidatedAt: null,
      })
      .onConflictDoUpdate({
        target: deviceRegistrations.pushToken,
        set: {
          userId: user.id,
          platform: body.platform,
          hidePreviews: body.hidePreviews ?? false,
          invalidatedAt: null,
        },
      });
    const [row] = await db
      .select()
      .from(deviceRegistrations)
      .where(eq(deviceRegistrations.pushToken, body.pushToken))
      .limit(1);
    return c.json(
      {
        device: {
          id: row!.id,
          pushToken: row!.pushToken,
          platform: row!.platform,
          hidePreviews: row!.hidePreviews,
          invalidatedAt: row!.invalidatedAt?.toISOString() ?? null,
        },
      },
      201,
    );
  });

  /**
   * List the current user's active devices (issue 12). Invalidated devices
   * are excluded from push delivery and from this list.
   */
  app.get('/v1/me/devices', async (c) => {
    const user = c.get('authUser');
    const rows = await db
      .select()
      .from(deviceRegistrations)
      .where(
        and(eq(deviceRegistrations.userId, user.id), isNull(deviceRegistrations.invalidatedAt)),
      );
    return c.json({
      devices: rows.map((row) => ({
        id: row.id,
        pushToken: row.pushToken,
        platform: row.platform,
        hidePreviews: row.hidePreviews,
      })),
    });
  });

  /**
   * Remove a device registration (issue 12). The token is invalidated so it
   * no longer receives pushes; the row is preserved for audit.
   */
  app.delete('/v1/me/devices/:deviceId', async (c) => {
    const user = c.get('authUser');
    const deviceId = c.req.param('deviceId');
    await db
      .update(deviceRegistrations)
      .set({ invalidatedAt: new Date() })
      .where(and(eq(deviceRegistrations.id, deviceId), eq(deviceRegistrations.userId, user.id)));
    return c.json({ ok: true });
  });

  /**
   * Unread message count for the current user in a household (issue 12,
   * AC#8 — muted notifications preserve correct in-app unread). The count is
   * independent of the push notification level so a muted person still sees
   * the correct unread badge in-app.
   */
  app.get('/v1/households/:householdId/unread', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const [stateRow] = await db
      .select()
      .from(householdMemberState)
      .where(
        and(
          eq(householdMemberState.userId, principal.userId),
          eq(householdMemberState.householdId, principal.householdId),
        ),
      )
      .limit(1);
    const lastReadId = stateRow?.lastReadMessageId;
    let unreadCount: number;
    if (!lastReadId) {
      const [agg] = await db
        .select({ value: count() })
        .from(chatMessages)
        .where(
          and(eq(chatMessages.householdId, principal.householdId), isNull(chatMessages.deletedAt)),
        );
      unreadCount = Number(agg?.value ?? 0);
    } else {
      const [lastReadRow] = await db
        .select({ serverCreatedAt: chatMessages.serverCreatedAt })
        .from(chatMessages)
        .where(eq(chatMessages.id, lastReadId))
        .limit(1);
      const cutoff = lastReadRow?.serverCreatedAt ?? new Date(0);
      const [agg] = await db
        .select({ value: count() })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.householdId, principal.householdId),
            isNull(chatMessages.deletedAt),
            gt(chatMessages.serverCreatedAt, cutoff),
          ),
        );
      unreadCount = Number(agg?.value ?? 0);
    }
    return c.json({ unread: unreadCount });
  });
}
