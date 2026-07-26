import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netAvailable, classifyConfidence, emptyNeed, confidenceAfterRemoval } from '../pantry.js';

const NOW = new Date('2026-01-10T10:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000).toISOString();

test('netAvailable sums deltas', () => {
  const net = netAvailable(
    [
      ledger('tomato', 500, null, null, day(1), false, null),
      ledger('tomato', 200, null, null, day(0), false, null),
    ],
    NOW,
  );
  assert.equal(net.g, 700);
});

test('perishables beyond freshness window contribute nothing', () => {
  const net = netAvailable([ledger('milk', null, 1000, null, day(6), true, 3)], NOW);
  assert.equal(net.ml, 0); // spoiled after 3 days
});

test('perishables within window count fully', () => {
  const net = netAvailable([ledger('milk', null, 1000, null, day(1), true, 3)], NOW);
  assert.equal(net.ml, 1000);
});

test('classifyConfidence: unknown when no data', () => {
  assert.equal(
    classifyConfidence({ g: 0, ml: 0, count: 0, hasData: false }, emptyNeed()),
    'unknown',
  );
});

test('classifyConfidence: likely_available when need covered', () => {
  const need = { g: 300, ml: 0, count: 0, hasData: true };
  const net = { g: 500, ml: 0, count: 0, hasData: true };
  assert.equal(classifyConfidence(net, need), 'likely_available');
});

test('classifyConfidence: may be low when partially covered', () => {
  const need = { g: 500, ml: 0, count: 0, hasData: true };
  const net = { g: 100, ml: 0, count: 0, hasData: true };
  assert.equal(classifyConfidence(net, need), 'may_be_low');
});

test('member removal reason already_have bumps confidence to likely_available', () => {
  assert.equal(confidenceAfterRemoval('already_have', 'may_be_low'), 'likely_available');
  assert.equal(confidenceAfterRemoval('not_needed', 'may_be_low'), 'may_be_low');
  assert.equal(confidenceAfterRemoval(null, 'unknown'), 'unknown');
});

function ledger(
  ingredientKey: string,
  g: number | null,
  ml: number | null,
  count: number | null,
  at: string,
  perishable: boolean,
  freshnessDays: number | null,
) {
  return {
    id: 'l',
    householdId: 'h' as never,
    ingredientKey,
    deltaG: g,
    deltaMl: ml,
    deltaCount: count,
    source: 'order_delivered' as const,
    perishable,
    freshnessDays,
    at,
  };
}
