import { and, eq, inArray } from 'drizzle-orm';
import {
  brandId,
  dispatchEventPushes,
  dispatchMessagePushes,
  type HouseholdRole,
  type NotificationLevel,
  type PushDispatcher,
  type PushNotification,
  type ResolveRecipientsInput,
  type SystemEventType,
} from '@cooklink/domain';
import { deviceRegistrations, households, householdMemberState, memberships } from '@cooklink/db';
import type { Database } from '@cooklink/db';
import type { Logger } from 'pino';

/**
 * Server-side push notification delivery (issue 12).
 *
 * Gathers the household's recipients (members, per-household overrides,
 * devices) after a durable write commits, then fire-and-forget dispatches
 * role-aware pushes. Invalid tokens reported by the provider are retired.
 * Errors are logged and never propagate to the caller.
 */

/**
 * A no-op push dispatcher used when no real push adapter is configured
 * (development, tests). Records nothing and always reports success so the
 * dispatch pipeline runs end-to-end without a provider.
 */
export class NoopPushDispatcher implements PushDispatcher {
  async dispatch(_notification: PushNotification) {
    return { ok: true as const };
  }
}

/**
 * Gather the push-dispatch input (members, member states, devices) for a
 * household (issue 12). Runs outside any write transaction so push dispatch
 * never blocks or rolls back the durable write.
 */
async function gatherPushInput(
  db: Database,
  householdId: string,
): Promise<{
  members: {
    id: string;
    userId: string;
    role: string;
    status: string;
    notificationDefault: string;
  }[];
  memberStates: { userId: string; householdId: string; notificationOverride: string | null }[];
  devices: {
    pushToken: string;
    userId: string;
    hidePreviews: boolean;
    invalidatedAt: Date | null;
  }[];
}> {
  const memberRows = await db
    .select()
    .from(memberships)
    .where(eq(memberships.householdId, householdId));
  const userIds = [...new Set(memberRows.map((m) => m.userId))];
  const stateRows =
    userIds.length > 0
      ? await db
          .select()
          .from(householdMemberState)
          .where(
            and(
              eq(householdMemberState.householdId, householdId),
              inArray(householdMemberState.userId, userIds),
            ),
          )
      : [];
  const deviceRows =
    userIds.length > 0
      ? await db
          .select()
          .from(deviceRegistrations)
          .where(inArray(deviceRegistrations.userId, userIds))
      : [];
  return {
    members: memberRows.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      status: m.status,
      notificationDefault: m.notificationDefault,
    })),
    memberStates: stateRows.map((s) => ({
      userId: s.userId,
      householdId: s.householdId,
      notificationOverride: s.notificationOverride,
    })),
    devices: deviceRows.map((d) => ({
      pushToken: d.pushToken,
      userId: d.userId,
      hidePreviews: d.hidePreviews,
      invalidatedAt: d.invalidatedAt,
    })),
  };
}

/**
 * Fire-and-forget push dispatch for a system event (issue 12). Gathers
 * recipient state after the durable write commits, resolves the role-aware
 * recipients, builds redacted previews, and dispatches. Invalid tokens are
 * retired (AC#8). Errors are logged and never propagate to the caller.
 */
export async function dispatchPushForEvent(
  db: Database,
  pushDispatcher: PushDispatcher,
  householdId: string,
  actorMembershipId: string | null,
  event: { type: string; entityId: string; payload: Record<string, unknown> },
  eventInput: { type: SystemEventType; sameDayMeal: boolean },
  previewText: string,
  log: Logger,
): Promise<void> {
  try {
    const [household] = await db
      .select()
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1);
    if (!household) return;
    const input = await gatherPushInput(db, householdId);
    const resolveInput: ResolveRecipientsInput = {
      householdId: brandId<'HouseholdId'>(householdId),
      actorMembershipId: actorMembershipId ? brandId<'MembershipId'>(actorMembershipId) : null,
      members: input.members.map((m) => ({
        id: brandId<'MembershipId'>(m.id),
        userId: brandId<'UserId'>(m.userId),
        householdId: brandId<'HouseholdId'>(householdId),
        role: m.role as HouseholdRole,
        status: m.status as 'active' | 'removed',
        notificationDefault: m.notificationDefault as NotificationLevel,
        joinedAt: '',
        removedAt: null,
      })),
      memberStates: input.memberStates.map((s) => ({
        userId: brandId<'UserId'>(s.userId),
        householdId: brandId<'HouseholdId'>(householdId),
        lastReadMessageId: null,
        notificationOverride: s.notificationOverride as NotificationLevel | null,
      })),
      devices: input.devices
        .filter((d) => !d.invalidatedAt)
        .map((d) => ({
          id: brandId<'DeviceId'>(''),
          userId: brandId<'UserId'>(d.userId),
          pushToken: d.pushToken,
          platform: 'ios' as const,
          hidePreviews: d.hidePreviews,
          invalidatedAt: null,
        })),
    };
    const domainEvent = {
      id: brandId<'SystemEventId'>(''),
      householdId: brandId<'HouseholdId'>(householdId),
      type: eventInput.type,
      actorId: actorMembershipId ? brandId<'MembershipId'>(actorMembershipId) : null,
      entityType: '',
      entityId: event.entityId,
      payload: event.payload,
      createdAt: new Date().toISOString(),
    };
    const result = await dispatchEventPushes(
      pushDispatcher,
      {
        id: brandId<'HouseholdId'>(householdId),
        name: household.name,
        photoUrl: household.photoUrl,
        servingCount: household.servingCount,
        mealStyle: household.mealStyle,
        dietStyle: household.dietStyle,
        healthEmphasis: household.healthEmphasis,
        specialMealEnabled: household.specialMealEnabled,
        defaultLanguage: household.defaultLanguage,
        createdAt: household.createdAt.toISOString(),
        closedAt: household.closedAt ? household.closedAt.toISOString() : null,
      },
      resolveInput,
      eventInput,
      domainEvent,
      previewText,
    );
    await retireInvalidTokens(db, result.invalidTokens);
    log.debug({
      msg: 'push.event_dispatched',
      householdId,
      type: eventInput.type,
      delivered: result.delivered,
      invalidTokens: result.invalidTokens.length,
    });
  } catch (err) {
    log.error({ msg: 'push.event_dispatch_failed', householdId, err });
  }
}

/**
 * Fire-and-forget push dispatch for a chat message (issue 12). Same lifecycle
 * as event dispatch: after the durable write, gather state, resolve, build,
 * dispatch, retire invalid tokens.
 */
export async function dispatchPushForMessage(
  db: Database,
  pushDispatcher: PushDispatcher,
  householdId: string,
  senderMembershipId: string,
  messageId: string,
  senderName: string,
  previewText: string,
  log: Logger,
): Promise<void> {
  try {
    const [household] = await db
      .select()
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1);
    if (!household) return;
    const input = await gatherPushInput(db, householdId);
    const resolveInput: ResolveRecipientsInput = {
      householdId: brandId<'HouseholdId'>(householdId),
      actorMembershipId: brandId<'MembershipId'>(senderMembershipId),
      members: input.members.map((m) => ({
        id: brandId<'MembershipId'>(m.id),
        userId: brandId<'UserId'>(m.userId),
        householdId: brandId<'HouseholdId'>(householdId),
        role: m.role as HouseholdRole,
        status: m.status as 'active' | 'removed',
        notificationDefault: m.notificationDefault as NotificationLevel,
        joinedAt: '',
        removedAt: null,
      })),
      memberStates: input.memberStates.map((s) => ({
        userId: brandId<'UserId'>(s.userId),
        householdId: brandId<'HouseholdId'>(householdId),
        lastReadMessageId: null,
        notificationOverride: s.notificationOverride as NotificationLevel | null,
      })),
      devices: input.devices
        .filter((d) => !d.invalidatedAt)
        .map((d) => ({
          id: brandId<'DeviceId'>(''),
          userId: brandId<'UserId'>(d.userId),
          pushToken: d.pushToken,
          platform: 'ios' as const,
          hidePreviews: d.hidePreviews,
          invalidatedAt: null,
        })),
    };
    const message = {
      id: brandId<'ChatMessageId'>(messageId),
      householdId: brandId<'HouseholdId'>(householdId),
      senderId: brandId<'MembershipId'>(senderMembershipId),
      kind: 'text' as const,
      body: previewText,
      caption: null,
      mediaRef: null,
      clientCreatedAt: new Date().toISOString(),
      serverCreatedAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
    };
    const result = await dispatchMessagePushes(
      pushDispatcher,
      {
        id: brandId<'HouseholdId'>(householdId),
        name: household.name,
        photoUrl: household.photoUrl,
        servingCount: household.servingCount,
        mealStyle: household.mealStyle,
        dietStyle: household.dietStyle,
        healthEmphasis: household.healthEmphasis,
        specialMealEnabled: household.specialMealEnabled,
        defaultLanguage: household.defaultLanguage,
        createdAt: household.createdAt.toISOString(),
        closedAt: household.closedAt ? household.closedAt.toISOString() : null,
      },
      resolveInput,
      message,
      senderName,
      previewText,
    );
    await retireInvalidTokens(db, result.invalidTokens);
    log.debug({
      msg: 'push.message_dispatched',
      householdId,
      delivered: result.delivered,
      invalidTokens: result.invalidTokens.length,
    });
  } catch (err) {
    log.error({ msg: 'push.message_dispatch_failed', householdId, err });
  }
}

/**
 * Retire invalid device tokens (issue 12, AC#8). Called after a dispatch
 * cycle reports tokens that the push provider rejected as invalid.
 */
async function retireInvalidTokens(db: Database, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  for (const token of tokens) {
    await db
      .update(deviceRegistrations)
      .set({ invalidatedAt: new Date() })
      .where(eq(deviceRegistrations.pushToken, token));
  }
}
