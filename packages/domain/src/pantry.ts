import type { PantryConfidence, PantryLedgerEntry } from './types.js';

/**
 * Estimated Pantry math (issue 05).
 *
 * The pantry is NEVER an exact inventory. It adds delivered-order quantities,
 * subtracts planned consumption, folds in approved Grocery Request overrides,
 * and degrades perishables through deterministic freshness windows. The only
 * user-facing states are {@link PantryConfidence}: `likely_available`,
 * `may_be_low`, `unknown`.
 */

export interface NetQuantity {
  g: number;
  ml: number;
  count: number;
  hasData: boolean;
}

/**
 * Sum ledger deltas, applying deterministic perishable freshness degradation.
 * A perishable entry whose freshness window has elapsed contributes nothing
 * (it should not remain "likely available" indefinitely — issue 05, AC#9).
 */
export function netAvailable(entries: PantryLedgerEntry[], now: Date): NetQuantity {
  const nowMs = now.getTime();
  let g = 0;
  let ml = 0;
  let count = 0;
  let hasData = false;
  for (const e of entries) {
    const atMs = Date.parse(e.at);
    const elapsedDays = (nowMs - atMs) / 86_400_000;
    const spoiled =
      e.perishable && e.freshnessDays != null && elapsedDays > e.freshnessDays;
    if (spoiled) continue;
    if (e.deltaG) g += e.deltaG;
    if (e.deltaMl) ml += e.deltaMl;
    if (e.deltaCount) count += e.deltaCount;
    hasData = true;
  }
  return { g, ml, count, hasData };
}

/**
 * Classify pantry confidence for an ingredient given its net availability and
 * the expected need for the three-day horizon.
 *
 * - No normalizable data at all → `unknown`.
 * - Net covers the expected need (with a 20% safety margin) → `likely_available`.
 * - Some but not enough → `may be low`.
 */
export function classifyConfidence(net: NetQuantity, need: NetQuantity): PantryConfidence {
  if (!net.hasData) return 'unknown';
  const covers = (have: number, want: number) => have >= want * 0.8;
  // Pick the unit the need is expressed in.
  if (need.g > 0) return covers(net.g, need.g) ? 'likely_available' : 'may_be_low';
  if (need.ml > 0) return covers(net.ml, need.ml) ? 'likely_available' : 'may_be_low';
  if (need.count > 0) return covers(net.count, need.count) ? 'likely_available' : 'may_be_low';
  // Need not quantifiable but we have pantry data: optimistically likely.
  return 'likely_available';
}

export function emptyNeed(): NetQuantity {
  return { g: 0, ml: 0, count: 0, hasData: false };
}

export function addNeed(a: NetQuantity, b: NetQuantity): NetQuantity {
  return {
    g: a.g + b.g,
    ml: a.ml + b.ml,
    count: a.count + b.count,
    hasData: a.hasData || b.hasData,
  };
}

/**
 * Apply a Member's optional cart-removal reason to pantry confidence
 * (issue 05, AC#8). No reason chosen → no inference.
 */
export function confidenceAfterRemoval(
  reason: 'already_have' | 'not_needed' | 'buy_later' | null,
  current: PantryConfidence,
): PantryConfidence {
  if (reason === 'already_have') return 'likely_available';
  return current;
}

/** The banned vs allowed user-facing language (issue 05, uncertainty rules). */
export const BANNED_PANTRY_TERMS = [
  'in stock',
  'available at home',
  'you have',
  'left in pantry',
] as const;

export const ALLOWED_PANTRY_TERMS = [
  'estimated',
  'likely available',
  'may be low',
  'unknown',
  'expected need',
  'based on recent orders and planned meals',
] as const;
