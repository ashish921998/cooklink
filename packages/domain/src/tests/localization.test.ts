import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderEvent,
  mealChangedPayload,
  mealPlanBulkPayload,
  groceryRequestPayload,
  groceryOrderPayload,
  membershipPayload,
  assertNoMoney,
} from '../chat-events.js';
import {
  groceryFollowUpQuestion,
  conflictActorLabel,
  memberActionLabels,
  similarityChoiceLabels,
} from '../grocery-request.js';
import type { SystemEvent } from '../domain-types.js';
import { brandId } from '../ids.js';

/**
 * Issue 13, AC#3 — localization coverage.
 *
 * English and Hindi navigation, system events, Recipe Guides, errors, and
 * dynamic layouts must be verified. This test proves that every bilingual
 * surface in the domain layer renders complete strings in both languages,
 * with no missing keys, no fallback to English when Hindi is requested, and
 * no leaked money fields in system event payloads.
 */

function makeEvent(type: SystemEvent['type'], payload: Record<string, unknown>): SystemEvent {
  return {
    id: brandId<'SystemEventId'>('evt-test'),
    householdId: brandId<'HouseholdId'>('h-test'),
    type,
    actorId: null,
    entityType: 'test',
    entityId: 'test',
    payload,
    createdAt: new Date().toISOString(),
  };
}

const ALL_EVENT_TYPES: SystemEvent['type'][] = [
  'meal.changed',
  'meal_plan.bulk_updated',
  'grocery_request.created',
  'grocery_request.updated',
  'grocery_request.cancelled',
  'grocery_request.approved',
  'grocery_request.rejected',
  'grocery_request.in_order',
  'grocery_request.fulfilled',
  'grocery_order.placed',
  'grocery_order.failed',
  'grocery_order.delivery_updated',
  'membership.joined',
  'membership.removed',
];

test('AC#3: every system event type renders in English', () => {
  const payloads: Record<SystemEvent['type'], Record<string, unknown>> = {
    'meal.changed': mealChangedPayload('2025-07-27', 'dinner', 'Dal Tadka'),
    'meal_plan.bulk_updated': mealPlanBulkPayload(7, '2025-07-27'),
    'grocery_request.created': groceryRequestPayload('नारियल', '2', 'pending'),
    'grocery_request.updated': groceryRequestPayload('नारियल', null, 'approved'),
    'grocery_request.cancelled': groceryRequestPayload('नारियल', null, 'cancelled'),
    'grocery_request.approved': groceryRequestPayload('नारियल', null, 'approved'),
    'grocery_request.rejected': groceryRequestPayload('नारियल', null, 'rejected'),
    'grocery_request.in_order': groceryRequestPayload('नारियल', null, 'in_order'),
    'grocery_request.fulfilled': groceryRequestPayload('नारियल', null, 'fulfilled'),
    'grocery_order.placed': groceryOrderPayload('placed', 2),
    'grocery_order.failed': groceryOrderPayload('failed'),
    'grocery_order.delivery_updated': groceryOrderPayload('delivery_updated'),
    'membership.joined': membershipPayload('cook', 'Raju'),
    'membership.removed': membershipPayload('cook', 'Raju'),
  };

  for (const type of ALL_EVENT_TYPES) {
    const event = makeEvent(type, payloads[type]!);
    const en = renderEvent(event, 'en');
    assert.ok(en.length > 0, `English render for ${type} should not be empty`);
    assert.ok(
      en !== type,
      `English render for ${type} should produce a human string, not the type key`,
    );
  }
});

test('AC#3: every system event type renders in Hindi', () => {
  const payloads: Record<SystemEvent['type'], Record<string, unknown>> = {
    'meal.changed': mealChangedPayload('2025-07-27', 'dinner', 'दाल तड़का'),
    'meal_plan.bulk_updated': mealPlanBulkPayload(7, '2025-07-27'),
    'grocery_request.created': groceryRequestPayload('नारियल', '2', 'pending'),
    'grocery_request.updated': groceryRequestPayload('नारियल', null, 'approved'),
    'grocery_request.cancelled': groceryRequestPayload('नारियल', null, 'cancelled'),
    'grocery_request.approved': groceryRequestPayload('नारियल', null, 'approved'),
    'grocery_request.rejected': groceryRequestPayload('नारियल', null, 'rejected'),
    'grocery_request.in_order': groceryRequestPayload('नारियल', null, 'in_order'),
    'grocery_request.fulfilled': groceryRequestPayload('नारियल', null, 'fulfilled'),
    'grocery_order.placed': groceryOrderPayload('placed', 2),
    'grocery_order.failed': groceryOrderPayload('failed'),
    'grocery_order.delivery_updated': groceryOrderPayload('delivery_updated'),
    'membership.joined': membershipPayload('cook', 'Raju'),
    'membership.removed': membershipPayload('cook', 'Raju'),
  };

  for (const type of ALL_EVENT_TYPES) {
    const event = makeEvent(type, payloads[type]!);
    const hi = renderEvent(event, 'hi');
    assert.ok(hi.length > 0, `Hindi render for ${type} should not be empty`);
    assert.ok(
      hi !== type,
      `Hindi render for ${type} should produce a human string, not the type key`,
    );
  }
});

test('AC#3: Hindi and English renders differ for every event type', () => {
  const payloads: Record<SystemEvent['type'], Record<string, unknown>> = {
    'meal.changed': mealChangedPayload('2025-07-27', 'breakfast', 'Poha'),
    'meal_plan.bulk_updated': mealPlanBulkPayload(3, '2025-07-27'),
    'grocery_request.created': groceryRequestPayload('Tomato', '1kg', 'pending'),
    'grocery_request.updated': groceryRequestPayload('Tomato', null, 'approved'),
    'grocery_request.cancelled': groceryRequestPayload('Tomato', null, 'cancelled'),
    'grocery_request.approved': groceryRequestPayload('Tomato', null, 'approved'),
    'grocery_request.rejected': groceryRequestPayload('Tomato', null, 'rejected'),
    'grocery_request.in_order': groceryRequestPayload('Tomato', null, 'in_order'),
    'grocery_request.fulfilled': groceryRequestPayload('Tomato', null, 'fulfilled'),
    'grocery_order.placed': groceryOrderPayload('placed', 1),
    'grocery_order.failed': groceryOrderPayload('failed'),
    'grocery_order.delivery_updated': groceryOrderPayload('delivery_updated'),
    'membership.joined': membershipPayload('member', 'Meera'),
    'membership.removed': membershipPayload('member', 'Meera'),
  };

  for (const type of ALL_EVENT_TYPES) {
    const event = makeEvent(type, payloads[type]!);
    const en = renderEvent(event, 'en');
    const hi = renderEvent(event, 'hi');
    assert.notEqual(en, hi, `English and Hindi renders for ${type} should differ`);
  }
});

test('AC#3: Hindi meal type labels are translated (not English)', () => {
  const breakfast = makeEvent(
    'meal.changed',
    mealChangedPayload('2025-07-27', 'breakfast', 'Poha'),
  );
  const lunch = makeEvent('meal.changed', mealChangedPayload('2025-07-27', 'lunch', 'Rajma'));
  const dinner = makeEvent('meal.changed', mealChangedPayload('2025-07-27', 'dinner', 'Dal'));

  assert.ok(renderEvent(breakfast, 'hi').includes('नाश्ता'));
  assert.ok(renderEvent(lunch, 'hi').includes('दोपहर'));
  assert.ok(renderEvent(dinner, 'hi').includes('रात का खाना'));
});

test('AC#3: system event payloads contain no money fields', () => {
  const payloads = [
    mealChangedPayload('2025-07-27', 'dinner', 'Dal'),
    mealPlanBulkPayload(7, '2025-07-27'),
    groceryRequestPayload('Tomato', '2', 'pending'),
    groceryOrderPayload('placed', 2),
    membershipPayload('cook', 'Raju'),
  ];
  for (const p of payloads) {
    assert.doesNotThrow(() => assertNoMoney(p));
  }
});

test('AC#3: groceryFollowUpQuestion is bilingual', () => {
  const en = groceryFollowUpQuestion('en');
  const hi = groceryFollowUpQuestion('hi');
  assert.ok(en.length > 0);
  assert.ok(hi.length > 0);
  assert.notEqual(en, hi);
  assert.equal(en, 'What do you need?');
  assert.equal(hi, 'क्या चाहिए?');
});

test('AC#3: conflictActorLabel is bilingual', () => {
  const en = conflictActorLabel('Raju', 'en');
  const hi = conflictActorLabel('Raju', 'hi');
  assert.ok(en.includes('Raju'));
  assert.ok(hi.includes('Raju'));
  assert.ok(hi.includes('बदला'));
  assert.ok(en.includes('changed'));
  assert.notEqual(en, hi);
});

test('AC#3: memberActionLabels returns complete labels in both languages', () => {
  const en = memberActionLabels('en');
  const hi = memberActionLabels('hi');

  assert.ok(en.approve && en.approve.length > 0);
  assert.ok(en.reject && en.reject.length > 0);
  assert.ok(en.orderNow && en.orderNow.length > 0);
  assert.ok(en.leave && en.leave.length > 0);

  assert.ok(hi.approve && hi.approve.length > 0);
  assert.ok(hi.reject && hi.reject.length > 0);
  assert.ok(hi.orderNow && hi.orderNow.length > 0);
  assert.ok(hi.leave && hi.leave.length > 0);

  assert.notEqual(en.approve, hi.approve);
  assert.notEqual(en.reject, hi.reject);
  assert.notEqual(en.orderNow, hi.orderNow);
  assert.notEqual(en.leave, hi.leave);
});

test('AC#3: similarityChoiceLabels returns complete labels in both languages', () => {
  const en = similarityChoiceLabels('en');
  const hi = similarityChoiceLabels('hi');

  assert.ok(en.updateQuantity && en.updateQuantity.length > 0);
  assert.ok(en.keepSeparate && en.keepSeparate.length > 0);

  assert.ok(hi.updateQuantity && hi.updateQuantity.length > 0);
  assert.ok(hi.keepSeparate && hi.keepSeparate.length > 0);

  assert.notEqual(en.updateQuantity, hi.updateQuantity);
  assert.notEqual(en.keepSeparate, hi.keepSeparate);
});

test('AC#3: MealPlan screen LABELS have equal English and Hindi key coverage', () => {
  // Static analysis: read the MealPlan source and verify the en and hi label
  // objects have the same keys. This catches missing Hindi translations.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    join(__dirname, '../../../../apps/mobile/src/screens/MealPlan.tsx'),
    'utf8',
  );

  // Extract the en and hi blocks from the LABELS object
  const enMatch = source.match(/en:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
  const hiMatch = source.match(/hi:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
  assert.ok(enMatch, 'LABELS must have an en block');
  assert.ok(hiMatch, 'LABELS must have a hi block');

  // Extract key names from each block
  const enBlock = enMatch?.[1] ?? '';
  const hiBlock = hiMatch?.[1] ?? '';
  const enKeys = (enBlock.match(/^\s*(\w+):/gm) || []).map((k: string) =>
    k.trim().replace(':', ''),
  );
  const hiKeys = (hiBlock.match(/^\s*(\w+):/gm) || []).map((k: string) =>
    k.trim().replace(':', ''),
  );

  assert.ok(
    enKeys.length >= 20,
    `English labels should have at least 20 keys, got ${enKeys.length}`,
  );
  assert.equal(
    enKeys.length,
    hiKeys.length,
    `English has ${enKeys.length} keys but Hindi has ${hiKeys.length} — missing translations`,
  );

  // Verify every English key exists in Hindi
  const hiSet = new Set(hiKeys);
  for (const key of enKeys) {
    assert.ok(hiSet.has(key), `Hindi labels missing key: ${key}`);
  }
});
