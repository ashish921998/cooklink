import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderEvent,
  assertNoMoney,
  groceryOrderPayload,
  groceryRequestPayload,
} from '../chat-events.js';
import type { SystemEvent } from '../types.js';

function ev(type: SystemEvent['type'], payload: Record<string, unknown>): SystemEvent {
  return {
    id: 'e' as never,
    householdId: 'h' as never,
    type,
    actorId: null,
    entityType: 'x',
    entityId: 'y',
    payload,
    createdAt: '2026-01-10T00:00:00Z',
  };
}

test('renderEvent renders in English and Hindi', () => {
  const e = ev('grocery_request.created', groceryRequestPayload('coconut', '1', 'pending'));
  assert.match(renderEvent(e, 'en'), /Grocery request: coconut \(1\)/);
  assert.match(renderEvent(e, 'hi'), /सामान का अनुरोध: coconut/);
});

test('order payloads never contain money fields', () => {
  const p = groceryOrderPayload('placed', 2);
  assert.doesNotThrow(() => assertNoMoney(p));
  assert.equal('totalCents' in p, false);
  assert.equal('amount' in p, false);
});

test('assertNoMoney throws if a money field leaks', () => {
  assert.throws(() => assertNoMoney({ total: 499 }), /money field/);
});

test('meal.changed renders the meal name', () => {
  const e = ev('meal.changed', { date: '2026-01-10', mealType: 'dinner', name: 'Paneer' });
  assert.match(renderEvent(e, 'en'), /Dinner on 2026-01-10 is now Paneer/);
});
