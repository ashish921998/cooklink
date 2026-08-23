import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const SRC = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

test('pre-launch product funnel events have one typed contract', () => {
  const contract = read('lib/analytics-events.ts');
  for (const event of [
    'week_day_selected',
    'meal_plan_opened',
    'recipe_opened',
    'cart_review_opened',
    'checkout_started',
  ]) {
    assert.match(contract, new RegExp(`\\b${event}:`), `${event} is missing from the contract`);
  }
});

test('analytics contract excludes household content and direct identifiers', () => {
  const contract = read('lib/analytics-events.ts');
  for (const forbidden of [
    'phone',
    'email',
    'name:',
    'household_id',
    'meal_id',
    'address_id',
    'cart_item_id',
  ]) {
    assert.ok(!contract.includes(forbidden), `${forbidden} must not be an analytics property`);
  }
});

test('PostHog is explicit-event only and disabled without configuration', () => {
  const analytics = read('lib/analytics.ts');
  assert.ok(analytics.includes('apiKey && !explicitlyDisabled && !designPreview'));
  assert.ok(analytics.includes('disableGeoip: true'));
  assert.ok(analytics.includes('enableSessionReplay: false'));
  assert.ok(analytics.includes('before_send: (event)'));
  assert.ok(analytics.includes('properties: { ...event.properties, is_test_event: __DEV__ }'));
  assert.ok(analytics.includes('{ ...properties, is_test_event: __DEV__ }'));
  assert.ok(!analytics.includes('captureTouches'));
  assert.ok(!analytics.includes('PostHogProvider'));
});

test('core funnel surfaces emit their corresponding events', () => {
  const member = read('screens/MemberShell.tsx');
  const plan = read('screens/MealPlan.tsx');
  const checkout = read('components/InstamartOrderFlow.tsx');
  assert.ok(member.includes("captureAnalyticsEvent('week_day_selected'"));
  assert.ok(member.includes("captureAnalyticsEvent('meal_plan_opened'"));
  assert.ok(plan.includes("captureAnalyticsEvent('recipe_opened'"));
  assert.ok(checkout.includes("captureAnalyticsEvent('cart_review_opened'"));
  assert.ok(checkout.includes("captureAnalyticsEvent('checkout_started'"));
});
