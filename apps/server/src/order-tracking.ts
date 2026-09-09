import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { groceryOrders, memberships, systemEvents } from '@cooklink/db';
import { ProviderError, type GroceryProvider, type UserId } from '@cooklink/domain';
import type { Database } from '@cooklink/db';
import type { JobResult } from './jobs.js';

/**
 * Background grocery order tracking (issue 07 — poll eligible active orders).
 *
 * The scheduler calls {@link OrderTracker.pollActiveOrders} no faster than
 * every ten seconds. For every `placed` Grocery Order with a provider order
 * id, the tracker re-checks the provider's live status using the placing
 * member's own Swiggy session (bearer tokens are per member user) and
 * persists progression:
 *
 * - `delivered` → Grocery Order status `delivered` + a `grocery_order.delivery_updated`
 *   system event.
 * - `out_for_delivery` → status stays `placed` + a `grocery_order.delivery_updated`
 *   system event (announced once per observed status).
 * - `cancelled` / `failed` → Grocery Order status `failed` + a `grocery_order.failed`
 *   system event.
 * - `placed` / `confirmed` → status stays `placed`, no event.
 *
 * Safety properties:
 * - The tracker is strictly read-only towards the provider (`get_orders`
 *   only). It never submits, retries, or cancels an order.
 * - Work claiming is a real database lease, not just per-process state. Each
 *   poll claims up to {@link MAX_TRACKED_ORDERS} eligible orders in one
 *   transaction: the claim `SELECT ... FOR UPDATE SKIP LOCKED`s the rows and
 *   stamps their `tracked_at` with the poll time before committing, so any
 *   other replica's claim within the lease window ({@link PER_ORDER_LEASE_MS})
 *   cannot re-claim them. A member advisory lock spans the provider request,
 *   preventing overlap even when a slow request outlasts the claim window.
 *   The lease is shorter than the scheduler cadence, so
 *   the normal 10-second per-order re-check is unchanged. Correctness never
 *   depends on the lease: even if two replicas did poll the same order, the
 *   locked monotonic transition below makes event emission exactly-once.
 * - Claimed orders are picked least-recently-attempted first (`tracked_at
 *   ASC NULLS FIRST`), and every attempt — including a member error or an
 *   order absent from the provider's history — has stamped `tracked_at`, so
 *   a slow member cannot starve later orders of the 100-row bound.
 * - Status transitions are monotonic against the observed state: inside a
 *   `FOR UPDATE` transaction the stored `provider_status` is re-read and the
 *   new status is applied only if it ranks strictly higher (placed <
 *   confirmed < out_for_delivery < delivered/terminal). A stale replica
 *   response can never regress a confirmed/out_for_delivery/delivered order
 *   or re-emit its event later.
 * - Terminal orders (`delivered` / `failed`) stop being eligible immediately.
 * - Expired member sessions, provider rate limits, and transient upstream
 *   failures skip the affected member (or back the whole poll off for rate
 *   limits) without crashing the scheduler loop.
 */

export interface OrderTracker {
  pollActiveOrders(now: Date): Promise<JobResult>;
}

export interface OrderTrackerOptions {
  db: Database;
  /**
   * The grocery provider. Omitted in stub deployments (see
   * `COOKLINK_SWIGGY_MODE`), which makes the tracker a no-op.
   */
  provider?: GroceryProvider;
  /** The real-ordering feature gate (issue 11, AC#9). */
  orderingEnabled: boolean;
  log?: Logger;
}

/** Upper bound on orders re-checked per poll cycle (bounded provider load). */
const MAX_TRACKED_ORDERS = 100;

/**
 * Per-order claim lease. An order claimed (attempted) within the last 5
 * seconds is not re-claimed by any replica. Well below the 10s scheduler
 * cadence, so each order is still re-checked every cycle in normal operation.
 */
const PER_ORDER_LEASE_MS = 5_000;

export function createOrderTracker(options: OrderTrackerOptions): OrderTracker {
  const { db, provider, orderingEnabled, log } = options;
  let inFlight = false;

  async function pollActiveOrders(now: Date): Promise<JobResult> {
    // Feature-gated: no provider (stub deployment) or ordering disabled means
    // there is nothing to track and no provider session to use.
    if (!provider || !orderingEnabled) return { affected: 0 };
    // Cheap per-process guard; cross-replica overlap is prevented by the
    // database claim lease below.
    if (inFlight) return { affected: 0 };
    inFlight = true;
    try {
      return await pollOnce(now);
    } finally {
      inFlight = false;
    }
  }

  /**
   * Claim the next bounded batch of eligible orders through the database.
   * The claim transaction locks the rows (`FOR UPDATE SKIP LOCKED`) and
   * stamps `tracked_at` atomically with the selection, so concurrent claims
   * on any replica take disjoint sets, and a claim within the lease window
   * (from any replica) is never re-claimed.
   */
  async function claimOrders(now: Date) {
    const leaseCutoff = new Date(now.getTime() - PER_ORDER_LEASE_MS);
    return db.transaction(async (tx) => {
      const selected = await tx
        .select({
          id: groceryOrders.id,
          householdId: groceryOrders.householdId,
          providerOrderId: groceryOrders.providerOrderId,
          providerStatus: groceryOrders.providerStatus,
          userId: memberships.userId,
        })
        .from(groceryOrders)
        .innerJoin(memberships, eq(memberships.id, groceryOrders.placedById))
        .where(
          and(
            eq(groceryOrders.status, 'placed'),
            isNotNull(groceryOrders.providerOrderId),
            // Lease: an order attempted within the lease window is skipped.
            or(isNull(groceryOrders.trackedAt), lt(groceryOrders.trackedAt, leaseCutoff)),
          ),
        )
        // Fairness: least-recently-attempted first, never-tracked first.
        .orderBy(sql`${groceryOrders.trackedAt} asc nulls first`)
        .limit(MAX_TRACKED_ORDERS)
        .for('update', { skipLocked: true });
      if (selected.length === 0) return [];
      await tx
        .update(groceryOrders)
        .set({ trackedAt: now })
        .where(
          inArray(
            groceryOrders.id,
            selected.map((row) => row.id),
          ),
        );
      return selected;
    });
  }

  async function pollOnce(now: Date): Promise<JobResult> {
    const rows = await claimOrders(now);

    // Group by placing membership: one get_orders call per member session.
    const byMembership = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byMembership.get(row.userId) ?? [];
      group.push(row);
      byMembership.set(row.userId, group);
    }

    let changed = 0;
    for (const [userId, group] of byMembership) {
      let providerOrders;
      try {
        // Keep a transaction-scoped member lock throughout the remote read.
        // A short claim can expire while Swiggy is slow; the lock prevents a
        // second replica from overlapping that member's request regardless.
        providerOrders = await db.transaction(async (tx) => {
          const lock = await tx.execute<{ acquired: boolean }>(sql`
            select pg_try_advisory_xact_lock(
              hashtext('cooklink.order_tracking'), hashtext(${userId})
            ) as acquired
          `);
          if (!lock.rows[0]?.acquired) return null;
          return provider!.getOrders(userId as UserId);
        });
        if (!providerOrders) continue;
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'rate_limited') {
          // Back the whole poll off until the next scheduled cycle; hammering
          // a rate-limited provider would only extend the limit. Claimed
          // orders keep their fresh tracked_at, so unpolled members are not
          // starved behind this one.
          log?.info({ msg: 'order_tracking.rate_limited', userId });
          return { affected: changed };
        }
        // Expired sessions (the provider has already dropped the dead token)
        // and transient upstream errors are retried on the next cycle for
        // that member only; other members' orders keep progressing. The
        // attempt was recorded by the claim, so this member's orders go to
        // the back of the fairness queue.
        log?.info({
          msg: 'order_tracking.member_skipped',
          userId,
          code: err instanceof ProviderError ? err.code : 'unknown',
        });
        continue;
      }

      const liveById = new Map(providerOrders.map((order) => [order.id, order]));
      for (const row of group) {
        const live = liveById.get(row.providerOrderId!);
        // Absent from history (e.g. beyond the recent-orders window) proves
        // nothing — never infer a terminal failure from absence. The claim
        // already recorded the attempt.
        if (!live) continue;
        const next = classifyProviderStatus(live.status);
        const progressed = await persistProgression(db, row, live.status, next, now);
        if (progressed) changed += 1;
      }
    }
    return { affected: changed };
  }

  return { pollActiveOrders };
}

type TrackedOrderRow = {
  id: string;
  householdId: string;
  providerOrderId: string | null;
  providerStatus: string | null;
};

interface OrderProgression {
  /** The Cooklink grocery order status to persist. */
  orderStatus: 'placed' | 'delivered' | 'failed';
  /** The existing system event type announced for this transition, if any. */
  eventType: 'grocery_order.delivery_updated' | 'grocery_order.failed' | null;
}

/** Map a live provider status onto Cooklink progression (existing events only). */
export function classifyProviderStatus(status: string): OrderProgression {
  switch (status) {
    case 'delivered':
      return { orderStatus: 'delivered', eventType: 'grocery_order.delivery_updated' };
    case 'cancelled':
    case 'failed':
      return { orderStatus: 'failed', eventType: 'grocery_order.failed' };
    case 'out_for_delivery':
      return { orderStatus: 'placed', eventType: 'grocery_order.delivery_updated' };
    default:
      // placed / confirmed: still in flight, nothing to announce yet.
      return { orderStatus: 'placed', eventType: null };
  }
}

/**
 * Monotonic rank of an observed provider status. `null` (nothing observed
 * yet) ranks lowest; unrecognized statuses rank with `null` so they can never
 * overwrite or regress a known observation.
 */
function providerStatusRank(status: string | null): number {
  switch (status) {
    case null:
      return -1;
    case 'placed':
      return 0;
    case 'confirmed':
      return 1;
    case 'out_for_delivery':
      return 2;
    case 'delivered':
    case 'cancelled':
    case 'failed':
      return 3;
    default:
      return -1;
  }
}

/**
 * Persist one order's progression in a transaction. The row is locked
 * (`FOR UPDATE`) and the stored `provider_status` — the last observed state,
 * possibly advanced by a concurrent replica — is re-read inside the lock, so
 * the transition is applied only when it strictly advances the observed
 * status. That makes the status write and its system event atomic and
 * exactly-once, even with overlapping or replicated pollers, and prevents
 * stale provider responses from regressing the order. Returns whether this
 * call won the transition.
 */
async function persistProgression(
  db: Database,
  row: TrackedOrderRow,
  liveStatus: string,
  next: OrderProgression,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: groceryOrders.status, providerStatus: groceryOrders.providerStatus })
      .from(groceryOrders)
      .where(eq(groceryOrders.id, row.id))
      .for('update');
    if (!current || current.status !== 'placed') return false; // terminal orders never regress
    // Monotonic observed state: same status (already announced) or an
    // older-ranked response (a stale replica read) is dropped.
    if (providerStatusRank(liveStatus) <= providerStatusRank(current.providerStatus)) {
      return false;
    }
    await tx
      .update(groceryOrders)
      .set({
        status: next.orderStatus,
        providerStatus: liveStatus,
        trackedAt: now,
      })
      .where(eq(groceryOrders.id, row.id));
    if (next.eventType) {
      // Safe rendering payload — never money (issue 06, AC#24).
      await tx.insert(systemEvents).values({
        id: randomUUID(),
        householdId: row.householdId,
        type: next.eventType,
        actorId: null,
        entityType: 'grocery_order',
        entityId: row.id,
        payload: { status: liveStatus },
      });
    }
    return true;
  });
}
