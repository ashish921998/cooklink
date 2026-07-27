import type { HouseholdId, MembershipId, UserId } from './ids.js';
import type { HouseholdRole } from './roles.js';
import type {
  ChatMessage,
  DeviceRegistration,
  Household,
  HouseholdMemberState,
  Membership,
  NotificationLevel,
  SystemEvent,
  SystemEventType,
} from './types.js';
import {
  buildPreview,
  collapseKey,
  resolveLevel,
  shouldDeliverToRecipient,
  type EventPushInput,
  type PushPreview,
} from './notifications.js';

/**
 * Push notification dispatch pipeline (issue 12).
 *
 * The pure half of push delivery: given a Household's members, their state,
 * and their active devices, decide WHO receives a push, WHAT preview text
 * they see, and HOW bursts collapse into one updating notification.
 *
 * The server supplies an imperative {@link PushDispatcher} implementation
 * (Expo, APNs/FCM); tests supply a recording one. This module never sends a
 * real HTTP push, never trusts a stale payload as authorization, and never
 * leaks money into a preview.
 */

/** A resolved recipient with their device and effective notification level. */
export interface PushRecipient {
  userId: UserId;
  membershipId: MembershipId;
  role: HouseholdRole;
  device: DeviceRegistration;
  level: NotificationLevel;
}

/** Input needed to resolve push recipients for one household event/message. */
export interface ResolveRecipientsInput {
  householdId: HouseholdId;
  /** The actor's membership id, or null for system-generated events. */
  actorMembershipId: MembershipId | null;
  members: Membership[];
  /** Per-user-per-household state (carries the notification override). */
  memberStates: HouseholdMemberState[];
  /** All active (non-invalidated) devices for users in this household. */
  devices: DeviceRegistration[];
}

/**
 * Resolve the effective notification level for a membership.
 *
 * New memberships default Members (and Owners) to All activity, Cooks to
 * Important only (issue 12, AC#1). A per-household override wins over the
 * default (AC#2).
 */
export function effectiveLevel(
  membership: Membership,
  state: HouseholdMemberState | null,
): NotificationLevel {
  return resolveLevel(membership.notificationDefault, state?.notificationOverride ?? null);
}

/**
 * Resolve which (user, device) pairs should receive a push for a system event.
 *
 * Rules (issue 12):
 * - The actor never receives a push for their own action (AC#5).
 * - A muted level suppresses the push entirely (AC#2).
 * - Important-only recipients get pushes only for events that qualify as
 *   important for their role (AC#3).
 * - Invalidated devices are excluded; only active devices receive (AC#8).
 *
 * The `eventInput.type` and `eventInput.sameDayMeal` describe the event; the
 * `role` field is resolved per-recipient from each membership, so the
 * important-only filter applies correctly to each person's role.
 */
export function resolveRecipientsForEvent(
  input: ResolveRecipientsInput,
  eventInput: Omit<EventPushInput, 'role'>,
): PushRecipient[] {
  const recipients: PushRecipient[] = [];
  for (const membership of input.members) {
    if (membership.status !== 'active') continue;
    if (input.actorMembershipId && membership.id === input.actorMembershipId) continue;

    const state = input.memberStates.find((s) => s.userId === membership.userId) ?? null;
    const level = effectiveLevel(membership, state);
    const perRecipientInput: EventPushInput = { ...eventInput, role: membership.role };
    if (!shouldDeliverToRecipient(false, level, perRecipientInput)) continue;

    const userDevices = input.devices.filter(
      (d) => d.userId === membership.userId && !d.invalidatedAt,
    );
    for (const device of userDevices) {
      recipients.push({
        userId: membership.userId,
        membershipId: membership.id,
        role: membership.role,
        device,
        level,
      });
    }
  }
  return recipients;
}

/**
 * Resolve which (user, device) pairs should receive a push for a chat message.
 *
 * The sender never receives their own message (AC#5). Muted suppresses;
 * All and Important both push human messages (issue 12, AC#3).
 */
export function resolveRecipientsForMessage(input: ResolveRecipientsInput): PushRecipient[] {
  const recipients: PushRecipient[] = [];
  for (const membership of input.members) {
    if (membership.status !== 'active') continue;
    if (input.actorMembershipId && membership.id === input.actorMembershipId) continue;

    const state = input.memberStates.find((s) => s.userId === membership.userId) ?? null;
    const level = effectiveLevel(membership, state);
    if (!shouldDeliverToRecipient(false, level, { type: 'message' })) continue;

    const userDevices = input.devices.filter(
      (d) => d.userId === membership.userId && !d.invalidatedAt,
    );
    for (const device of userDevices) {
      recipients.push({
        userId: membership.userId,
        membershipId: membership.id,
        role: membership.role,
        device,
        level,
      });
    }
  }
  return recipients;
}

/** A single push notification payload ready for dispatch. */
export interface PushNotification {
  /** The push token of the target device. */
  token: string;
  title: string;
  body: string;
  /** Collapse key so multiple events from one Household update one notification (AC#4). */
  collapseKey: string;
  /** Household id for deep-link routing on tap. */
  householdId: HouseholdId;
  /** The system event type or 'message', for client routing. */
  kind: SystemEventType | 'message';
  /**
   * NEVER trusted as authorization. The client MUST call
   * GET /v1/households/:id/access on tap to re-authorize before showing
   * protected content (AC#7).
   */
  entityId: string | null;
}

/** Build push notification payloads from recipients for a system event. */
export function buildEventPushes(
  household: Household,
  recipients: PushRecipient[],
  event: SystemEvent,
  previewText: string,
): PushNotification[] {
  const key = collapseKey(household.id as string);
  return recipients.map((r) => {
    const preview: PushPreview = buildPreview({
      householdName: household.name,
      previewText,
      type: event.type,
      hidePreviews: r.device.hidePreviews,
    });
    return {
      token: r.device.pushToken,
      title: preview.title,
      body: preview.body,
      collapseKey: key,
      householdId: household.id,
      kind: event.type,
      entityId: event.entityId,
    };
  });
}

/** Build push notification payloads from recipients for a chat message. */
export function buildMessagePushes(
  household: Household,
  recipients: PushRecipient[],
  message: ChatMessage,
  senderName: string,
  previewText: string,
): PushNotification[] {
  const key = collapseKey(household.id as string);
  return recipients.map((r) => {
    const preview: PushPreview = buildPreview({
      householdName: household.name,
      previewText,
      type: 'message',
      hidePreviews: r.device.hidePreviews,
    });
    return {
      token: r.device.pushToken,
      title: preview.title,
      body: preview.body,
      collapseKey: key,
      householdId: household.id,
      kind: 'message',
      entityId: message.id as string,
    };
  });
}

/**
 * The imperative push dispatcher port. The server supplies an Expo/APNs/FCM
 * implementation; tests supply a recording one. Failures from invalid tokens
 * are reported back so the server can retire them (AC#8).
 */
export interface PushDispatcher {
  dispatch(notification: PushNotification): Promise<DispatchResult>;
}

export type DispatchResult =
  { ok: true } | { ok: false; reason: 'invalid_token' | 'rate_limited' | 'error'; detail?: string };

/**
 * A recording {@link PushDispatcher} for tests. Captures every notification
 * and lets the test configure per-token results (default: ok).
 */
export class RecordingPushDispatcher implements PushDispatcher {
  readonly sent: PushNotification[] = [];
  private readonly results = new Map<string, DispatchResult>();

  setResult(token: string, result: DispatchResult): void {
    this.results.set(token, result);
  }

  async dispatch(notification: PushNotification): Promise<DispatchResult> {
    this.sent.push(notification);
    return this.results.get(notification.token) ?? { ok: true };
  }
}

/**
 * Drive a full dispatch cycle for a system event. Resolves recipients, builds
 * previews, dispatches pushes, and returns tokens that should be invalidated
 * (AC#8 — invalid tokens are retired).
 */
export async function dispatchEventPushes(
  dispatcher: PushDispatcher,
  household: Household,
  resolveInput: ResolveRecipientsInput,
  eventInput: Omit<EventPushInput, 'role'>,
  event: SystemEvent,
  previewText: string,
): Promise<{ invalidTokens: string[]; delivered: number }> {
  const recipients = resolveRecipientsForEvent(resolveInput, eventInput);
  const pushes = buildEventPushes(household, recipients, event, previewText);
  return driveDispatcher(dispatcher, pushes);
}

/** Drive a full dispatch cycle for a chat message. */
export async function dispatchMessagePushes(
  dispatcher: PushDispatcher,
  household: Household,
  resolveInput: ResolveRecipientsInput,
  message: ChatMessage,
  senderName: string,
  previewText: string,
): Promise<{ invalidTokens: string[]; delivered: number }> {
  const recipients = resolveRecipientsForMessage(resolveInput);
  const pushes = buildMessagePushes(household, recipients, message, senderName, previewText);
  return driveDispatcher(dispatcher, pushes);
}

async function driveDispatcher(
  dispatcher: PushDispatcher,
  pushes: PushNotification[],
): Promise<{ invalidTokens: string[]; delivered: number }> {
  const invalidTokens: string[] = [];
  let delivered = 0;
  for (const push of pushes) {
    const result = await dispatcher.dispatch(push);
    if (result.ok) {
      delivered++;
    } else if (result.reason === 'invalid_token') {
      invalidTokens.push(push.token);
    }
  }
  return { invalidTokens, delivered };
}

/** Count unread messages for a user in a household (AC#8 — muted preserves unread). */
export function countUnread(
  timelineMessages: ChatMessage[],
  memberState: HouseholdMemberState | null,
): number {
  const lastRead = memberState?.lastReadMessageId;
  if (!lastRead) {
    return timelineMessages.filter((m) => !m.deletedAt).length;
  }
  // Messages are ordered by serverCreatedAt; count those after lastRead.
  let found = false;
  let count = 0;
  for (const msg of timelineMessages) {
    if (found) {
      if (!msg.deletedAt) count++;
    }
    if ((msg.id as string) === (lastRead as string)) {
      found = true;
    }
  }
  // If lastRead is not in the current window, everything is unread.
  if (!found) return timelineMessages.filter((m) => !m.deletedAt).length;
  return count;
}
