import type { Language, SystemEvent, SystemEventType } from './types.js';

/**
 * System events are immutable, attributed records of structured transitions.
 * Their payloads carry STATUS ONLY — never payment amounts, order totals, or
 * prices (issue 06, AC#24). The client renders Cooklink-authored text in the
 * viewer's selected English or Hindi locale.
 *
 * These builders are the ONLY way the server should construct event payloads,
 * so the "no money in Chat" rule is enforced by construction.
 */

export function mealChangedPayload(date: string, mealType: string, name: string) {
  return { date, mealType, name };
}
export function mealPlanBulkPayload(count: number, fromDay: string) {
  return { count, fromDay };
}
export function groceryRequestPayload(item: string, quantity: string | null, status: string) {
  return { item, quantity, status };
}
/** Order events deliberately omit money (issue 06, AC#16/24). */
export function groceryOrderPayload(status: string, storeCount?: number) {
  return { status, ...(storeCount != null ? { storeCount } : {}) };
}
export function membershipPayload(role: string, displayName?: string) {
  return { role, ...(displayName ? { displayName } : {}) };
}

const STRINGS: Record<
  Language,
  Partial<Record<SystemEventType, (p: Record<string, unknown>) => string>>
> = {
  en: {
    'meal.changed': (p) => `${cap(String(p.mealType))} on ${p.date} is now ${p.name}.`,
    'meal_plan.bulk_updated': (p) => `${p.count} meals were updated from ${p.fromDay}.`,
    'grocery_request.created': (p) =>
      `Grocery request: ${p.item}${p.quantity ? ` (${p.quantity})` : ''}.`,
    'grocery_request.updated': (p) => `Grocery request updated: ${p.item}.`,
    'grocery_request.cancelled': (p) => `Grocery request cancelled: ${p.item}.`,
    'grocery_request.approved': (p) => `Grocery request approved: ${p.item}.`,
    'grocery_request.rejected': (p) => `Grocery request declined: ${p.item}.`,
    'grocery_request.in_order': (p) => `${p.item} is in an order.`,
    'grocery_request.fulfilled': (p) => `${p.item} was delivered.`,
    'grocery_order.placed': () => 'Grocery order placed.',
    'grocery_order.failed': () => 'Checkout needs attention.',
    'grocery_order.delivery_updated': () => 'Grocery order delivery updated.',
    'membership.joined': (p) => `${p.displayName ?? 'Someone'} joined as ${p.role}.`,
    'membership.removed': (p) => `${p.displayName ?? 'A member'} was removed.`,
  },
  hi: {
    'meal.changed': (p) => `${p.date} को ${hiMeal(String(p.mealType))} अब ${p.name} है।`,
    'meal_plan.bulk_updated': (p) => `${p.fromDay} से ${p.count} भोजन बदले गए।`,
    'grocery_request.created': (p) =>
      `सामान का अनुरोध: ${p.item}${p.quantity ? ` (${p.quantity})` : ''}।`,
    'grocery_request.updated': (p) => `सामान का अनुरोध बदला: ${p.item}।`,
    'grocery_request.cancelled': (p) => `सामान का अनुरोध रद्द: ${p.item}।`,
    'grocery_request.approved': (p) => `सामान का अनुरोध स्वीकृत: ${p.item}।`,
    'grocery_request.rejected': (p) => `सामान का अनुरोध अस्वीकृत: ${p.item}।`,
    'grocery_request.in_order': (p) => `${p.item} ऑर्डर में है।`,
    'grocery_request.fulfilled': (p) => `${p.item} आ गया।`,
    'grocery_order.placed': () => 'किराने का ऑर्डर हो गया।',
    'grocery_order.failed': () => 'चेकआउट में ध्यान दें।',
    'grocery_order.delivery_updated': () => 'ऑर्डर की डिलीवरी अपडेट।',
    'membership.joined': (p) => `${p.displayName ?? 'कोई'} ${p.role} के रूप में जुड़े।`,
    'membership.removed': (p) => `${p.displayName ?? 'एक सदस्य'} हटाए गए।`,
  },
};

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
function hiMeal(m: string): string {
  return m === 'breakfast' ? 'नाश्ता' : m === 'lunch' ? 'दोपहर' : 'रात का खाना';
}

/** Render a system event in the viewer's language. Never throws. */
export function renderEvent(event: SystemEvent, lang: Language): string {
  const fn = STRINGS[lang][event.type];
  if (!fn) return event.type;
  try {
    return fn(event.payload);
  } catch {
    return event.type;
  }
}

/**
 * Guard: assert a payload contains no money fields. Used in tests to prove the
 * "no money in Chat" invariant (issue 06, AC#24).
 */
const MONEY_FIELDS = ['total', 'amount', 'price', 'totalCents', 'payment', 'paid', 'cost'];
export function assertNoMoney(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (MONEY_FIELDS.some((m) => key.toLowerCase().includes(m))) {
      throw new Error(`System event payload leaks money field: ${key}`);
    }
  }
}
