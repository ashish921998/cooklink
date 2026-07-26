import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLevel,
  isImportantEvent,
  shouldPushEvent,
  buildPreview,
  shouldDeliverToRecipient,
} from '../notifications.js';

test('resolveLevel: override wins over default', () => {
  assert.equal(resolveLevel('all', null), 'all');
  assert.equal(resolveLevel('all', 'muted'), 'muted');
  assert.equal(resolveLevel('important', 'all'), 'all');
});

test('muted level never pushes events', () => {
  assert.equal(
    shouldPushEvent('muted', { type: 'grocery_request.created', role: 'member', sameDayMeal: false }),
    false,
  );
});

test('member important-only: same-day meal change pushes, future does not', () => {
  assert.equal(
    isImportantEvent({ type: 'meal.changed', role: 'member', sameDayMeal: true }),
    true,
  );
  assert.equal(
    isImportantEvent({ type: 'meal.changed', role: 'member', sameDayMeal: false }),
    false,
  );
});

test('cook important-only: request approvals and same-day meals; routine future changes do not', () => {
  assert.equal(
    isImportantEvent({ type: 'grocery_request.approved', role: 'cook', sameDayMeal: false }),
    true,
  );
  assert.equal(
    isImportantEvent({ type: 'meal.changed', role: 'cook', sameDayMeal: false }),
    false,
  );
});

test('money/order event previews are always redacted even with previews on', () => {
  const p = buildPreview({
    householdName: 'Sharma',
    previewText: 'Order placed for ₹499',
    type: 'grocery_order.placed',
    hidePreviews: false,
  });
  assert.equal(p.body, 'Grocery order update');
  assert.ok(!p.body.includes('499'));
});

test('checkout failure preview is redacted to generic text', () => {
  const p = buildPreview({
    householdName: 'Sharma',
    previewText: 'Checkout failed for ₹499',
    type: 'grocery_order.failed',
    hidePreviews: false,
  });
  assert.equal(p.body, 'Checkout needs attention');
});

test('hidePreviews produces generic text with no detail', () => {
  const p = buildPreview({
    householdName: 'Sharma',
    previewText: 'Meera: bring milk',
    type: 'message',
    hidePreviews: true,
  });
  assert.equal(p.body, 'New Cooklink activity');
});

test('actor never receives their own push', () => {
  assert.equal(
    shouldDeliverToRecipient(true, 'all', { type: 'grocery_request.created', role: 'cook', sameDayMeal: false }),
    false,
  );
});
