import type { HouseholdRole } from './roles.js';
import type { NotificationLevel, SystemEventType } from './domain-types.js';

/**
 * Notification contract (issue 06).
 *
 * Defaults are role-aware: All activity for a Member, Important only for a
 * Cook. Each person may override a Household with All/Important/Muted.
 * Payment, checkout, and order amounts are ALWAYS redacted from previews
 * regardless of the per-device preview setting (issue 06, AC#16).
 */

export function resolveLevel(
  membershipDefault: NotificationLevel,
  override: NotificationLevel | null,
): NotificationLevel {
  return override ?? membershipDefault;
}

/** Whether a human message should produce a push at the given level. */
export function shouldPushMessage(level: NotificationLevel): boolean {
  return level !== 'muted'; // human messages are pushed at All and Important
}

export interface EventPushInput {
  type: SystemEventType;
  role: HouseholdRole;
  /** Whether the affected meal is today (drives same-day importance). */
  sameDayMeal: boolean;
}

/**
 * The role-aware "important-only" sets from issue 06.
 * Returns whether this event qualifies as important for the role.
 */
export function isImportantEvent(input: EventPushInput): boolean {
  const { type, role, sameDayMeal } = input;
  if (role === 'member') {
    switch (type) {
      case 'meal.changed':
        return sameDayMeal;
      case 'grocery_request.created':
      case 'grocery_request.updated':
      case 'grocery_request.cancelled':
        return true;
      case 'grocery_order.failed':
      case 'grocery_order.delivery_updated':
        return true;
      case 'membership.joined':
      case 'membership.removed':
        return true;
      default:
        return false;
    }
  }
  // cook
  switch (type) {
    case 'meal.changed':
      return sameDayMeal;
    case 'grocery_request.approved':
    case 'grocery_request.rejected':
    case 'grocery_request.cancelled':
    case 'grocery_request.in_order':
    case 'grocery_request.fulfilled':
      return true;
    // a request created by another active cook is surfaced to this cook
    case 'grocery_request.created':
      return true;
    case 'membership.joined':
    case 'membership.removed':
      return true;
    default:
      return false;
  }
}

export function shouldPushEvent(level: NotificationLevel, input: EventPushInput): boolean {
  if (level === 'muted') return false;
  if (level === 'all') return true;
  return isImportantEvent(input);
}

/** Money-sensitive event classes whose preview is ALWAYS redacted. */
const MONEY_SENSITIVE: ReadonlySet<SystemEventType> = new Set<SystemEventType>([
  'grocery_order.placed',
  'grocery_order.failed',
  'grocery_order.delivery_updated',
]);

export interface PreviewInput {
  householdName: string;
  previewText: string; // full readable text for coordination content
  type: SystemEventType | 'message';
  hidePreviews: boolean; // per-device setting
}

export interface PushPreview {
  title: string;
  body: string;
}

/**
 * Build an outbound push preview. Money/checkout/order amounts are redacted
 * unconditionally; a device with hidden previews gets generic text only
 * (issue 06, AC#16).
 */
export function buildPreview(input: PreviewInput): PushPreview {
  if (input.hidePreviews) {
    return { title: 'Cooklink', body: 'New Cooklink activity' };
  }
  if (input.type !== 'message' && MONEY_SENSITIVE.has(input.type)) {
    if (input.type === 'grocery_order.failed') {
      return { title: input.householdName, body: 'Checkout needs attention' };
    }
    return { title: input.householdName, body: 'Grocery order update' };
  }
  return { title: input.householdName, body: input.previewText };
}

/**
 * The actor never receives a push for their own action (issue 06, AC#15).
 */
export function shouldDeliverToRecipient(
  isActor: boolean,
  level: NotificationLevel,
  payload: EventPushInput | { type: 'message' },
): boolean {
  if (isActor) return false;
  if (payload.type === 'message') return shouldPushMessage(level);
  return shouldPushEvent(level, payload as EventPushInput);
}

/** Collapse bursts by household (issue 06, AC#15) — keyed by household id. */
export function collapseKey(householdId: string): string {
  return `household:${householdId}`;
}
