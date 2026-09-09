import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  createDatabase,
  groceryOrders,
  households,
  memberships,
  systemEvents,
  users,
} from '@cooklink/db';
import {
  ProviderError,
  type GroceryProvider,
  type ProviderOrder,
  type UserId,
} from '@cooklink/domain';
import { createOrderTracker } from '../order-tracking.js';

/**
 * Background order tracking (issue 07/13 — poll eligible active orders).
 *
 * Postgres-backed: the tracker must poll with the placing member's session,
 * persist progression with exactly-once, monotonic (never regressing)
 * transitions, claim work through a real database lease so concurrent
 * replicas never double-poll the same order, pick claimed orders
 * least-recently-attempted first so the 100-order bound is fair, back off on
 * rate limits, skip expired sessions and transient failures, stop at terminal
 * states, and never submit anything to the provider. Skipped without
 * DATABASE_URL like the other app tests.
 */

const testDbUrl = process.env.DATABASE_URL;

interface FakeState {
  orders: ProviderOrder[];
  calls: { tool: string; userId: string }[];
  /** When set, getOrders throws this for every member. */
  error?: ProviderError;
  /** When set, getOrders throws this for the given user only. */
  errorForUser?: { userId: string; error: ProviderError };
  /** When set, getOrders awaits this gate so a poll can be held open. */
  gate?: Promise<void>;
}

function makeOrder(id: string, status: ProviderOrder['status']): ProviderOrder {
  return {
    id,
    status,
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    totalCents: 12_600,
    items: [],
    placedAt: new Date().toISOString(),
    deliveryEta: null,
    trackingUrl: null,
    cancellableUntil: null,
    cancellationPolicy: 'policy',
  };
}

/**
 * A read-only fake provider: only `get_orders` is implemented, and the test
 * asserts nothing else is ever called — the tracker must never submit orders.
 */
function fakeProvider(state: FakeState): GroceryProvider {
  return {
    getOrders: async (userId: UserId) => {
      state.calls.push({ tool: 'get_orders', userId: userId as string });
      if (state.errorForUser && userId === (state.errorForUser.userId as UserId)) {
        throw state.errorForUser.error;
      }
      if (state.error) throw state.error;
      if (state.gate) await state.gate;
      return state.orders;
    },
  } as unknown as GroceryProvider;
}

test(
  'order tracking: progression, dedup, backoff, and terminal states',
  { skip: testDbUrl ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const db = createDatabase(testDbUrl);
    const now = new Date();

    /**
     * Each claimed order carries a `tracked_at` lease (5s), so a re-check
     * requires a later timestamp. Every poll that should actually reach the
     * database advances the clock; the cross-instance test below deliberately
     * pins one shared timestamp instead.
     */
    let tick = 0;
    const nextPollTime = () => new Date(now.getTime() + ++tick * 20_000);

    /**
     * Purge every fixture row this test family ever created (marked by the
     * `order-tracking-` Clerk-id prefix and the fixed household name). Keeps
     * each block's assertions deterministic even when re-running against a
     * persistent development database where an earlier run left rows behind.
     */
    async function purgeFixtures(): Promise<void> {
      const rows = await db
        .select({ id: households.id })
        .from(households)
        .where(eq(households.name, 'Order Tracking Test'));
      const householdIds = rows.map((row) => row.id);
      if (householdIds.length > 0) {
        await db.delete(systemEvents).where(inArray(systemEvents.householdId, householdIds));
        await db.delete(groceryOrders).where(inArray(groceryOrders.householdId, householdIds));
        await db.delete(memberships).where(inArray(memberships.householdId, householdIds));
        await db.delete(households).where(inArray(households.id, householdIds));
      }
      await db.delete(users).where(like(users.clerkUserId, 'order-tracking-%'));
    }

    await purgeFixtures();

    async function createMember(): Promise<{
      userId: string;
      membershipId: string;
      householdId: string;
    }> {
      const userId = randomUUID();
      const householdId = randomUUID();
      const membershipId = randomUUID();
      await db.insert(users).values({
        id: userId,
        clerkUserId: `order-tracking-${userId}`,
        phone: `+9199${userId.replaceAll('-', '').slice(0, 8)}`,
        displayName: 'Order Tracking Test',
      });
      await db.insert(households).values({ id: householdId, name: 'Order Tracking Test' });
      await db
        .insert(memberships)
        .values({ id: membershipId, userId, householdId, role: 'owner', status: 'active' });
      return { userId, membershipId, householdId };
    }

    async function createPlacedOrder(
      membershipId: string,
      householdId: string,
      providerOrderId: string,
    ): Promise<string> {
      const id = randomUUID();
      await db.insert(groceryOrders).values({
        id,
        householdId,
        placedById: membershipId,
        providerOrderId,
        status: 'placed',
        totalCents: 12_600,
      });
      return id;
    }

    async function getOrderRow(id: string) {
      const [row] = await db.select().from(groceryOrders).where(eq(groceryOrders.id, id)).limit(1);
      return row!;
    }

    async function eventsFor(orderId: string) {
      return db
        .select()
        .from(systemEvents)
        .where(
          and(eq(systemEvents.entityType, 'grocery_order'), eq(systemEvents.entityId, orderId)),
        );
    }

    // ---- 1. progression: placed → out_for_delivery → delivered, exactly-once events ----
    {
      const member = await createMember();
      const orderId = await createPlacedOrder(member.membershipId, member.householdId, 'ord-1');
      const state: FakeState = { orders: [makeOrder('ord-1', 'out_for_delivery')], calls: [] };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      // Other Postgres test suites may run in parallel against the same
      // database and place their own orders; every call-count assertion below
      // is scoped to this block's own member session.
      const callsForMember = () =>
        state.calls.filter((call) => call.userId === member.userId).length;

      const first = await tracker.pollActiveOrders(nextPollTime());
      assert.equal(first.affected, 1);
      let row = await getOrderRow(orderId);
      assert.equal(row!.status, 'placed');
      assert.equal(row!.providerStatus, 'out_for_delivery');
      let events = await eventsFor(orderId);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'grocery_order.delivery_updated');
      assert.deepEqual(events[0]!.payload, { status: 'out_for_delivery' });
      assert.equal(events[0]!.actorId, null);

      // The same status again: no duplicate event, no state regression.
      await tracker.pollActiveOrders(nextPollTime());
      events = await eventsFor(orderId);
      assert.equal(events.length, 1, 'the same provider status must never be announced twice');

      // Delivered: terminal status + event.
      state.orders = [makeOrder('ord-1', 'delivered')];
      const third = await tracker.pollActiveOrders(nextPollTime());
      assert.equal(third.affected, 1);
      row = await getOrderRow(orderId);
      assert.equal(row!.status, 'delivered');
      events = await eventsFor(orderId);
      assert.equal(events.length, 2);
      assert.equal(events[1]!.type, 'grocery_order.delivery_updated');

      // Terminal orders stop being polled entirely.
      const callsBefore = callsForMember();
      await tracker.pollActiveOrders(nextPollTime());
      assert.equal(callsForMember(), callsBefore, 'delivered orders must not be re-polled');
      await purgeFixtures();
    }

    // ---- 2. cancelled → failed with the failure event ----
    {
      const member = await createMember();
      const orderId = await createPlacedOrder(member.membershipId, member.householdId, 'ord-2');
      const state: FakeState = { orders: [makeOrder('ord-2', 'cancelled')], calls: [] };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      await tracker.pollActiveOrders(nextPollTime());
      const row = await getOrderRow(orderId);
      assert.equal(row!.status, 'failed');
      const events = await eventsFor(orderId);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'grocery_order.failed');
      await purgeFixtures();
    }

    // ---- 3. the tracker never submits anything (read-only towards the provider) ----
    {
      const member = await createMember();
      await createPlacedOrder(member.membershipId, member.householdId, 'ord-3');
      const state: FakeState = { orders: [makeOrder('ord-3', 'confirmed')], calls: [] };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      await tracker.pollActiveOrders(nextPollTime());
      assert.ok(state.calls.some((call) => call.userId === member.userId));
      for (const call of state.calls) {
        assert.equal(call.tool, 'get_orders', 'tracking must only ever read order history');
      }
      await purgeFixtures();
    }

    // ---- 4. expired session skips that member; other members keep progressing ----
    {
      const a = await createMember();
      const b = await createMember();
      const orderA = await createPlacedOrder(a.membershipId, a.householdId, 'ord-4a');
      const orderB = await createPlacedOrder(b.membershipId, b.householdId, 'ord-4b');
      const state: FakeState = {
        orders: [makeOrder('ord-4b', 'out_for_delivery')],
        calls: [],
        errorForUser: {
          userId: a.userId,
          error: new ProviderError(
            'Swiggy session expired. Connect again.',
            'expired_session',
            401,
          ),
        },
      };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      await tracker.pollActiveOrders(nextPollTime());
      const rowA = await getOrderRow(orderA);
      assert.equal(rowA!.providerStatus, null, 'an expired session must not advance the order');
      const rowB = await getOrderRow(orderB);
      assert.equal(rowB!.providerStatus, 'out_for_delivery');
      await purgeFixtures();
    }

    // ---- 5. a rate limit backs off the entire poll ----
    {
      const a = await createMember();
      const b = await createMember();
      await createPlacedOrder(a.membershipId, a.householdId, 'ord-5a');
      const orderB = await createPlacedOrder(b.membershipId, b.householdId, 'ord-5b');
      const state: FakeState = {
        orders: [makeOrder('ord-5b', 'out_for_delivery')],
        calls: [],
        errorForUser: {
          userId: a.userId,
          error: new ProviderError('Swiggy rate limit reached.', 'rate_limited', 429),
        },
      };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      await tracker.pollActiveOrders(nextPollTime());
      // Backoff invariant: once the rate limit hits, the poll stops. Member b
      // must never be polled AFTER member a's rate-limited call (b may
      // legitimately be polled first when rows come back in that order).
      const aFirstCall = state.calls.findIndex((call) => call.userId === a.userId);
      assert.ok(aFirstCall >= 0, 'the rate-limited member must have been polled');
      assert.ok(
        !state.calls.slice(aFirstCall + 1).some((call) => call.userId === b.userId),
        'a rate limit must stop the poll, not skip ahead',
      );
      const rowB = await getOrderRow(orderB);
      // b either progressed before the rate limit hit, or was never polled.
      const bWasPolled = state.calls.some((call) => call.userId === b.userId);
      if (!bWasPolled) assert.equal(rowB!.providerStatus, null);
      await purgeFixtures();
    }

    // ---- 6. feature gates: disabled ordering or missing provider = no-op ----
    {
      const member = await createMember();
      await createPlacedOrder(member.membershipId, member.householdId, 'ord-6');
      const state: FakeState = { orders: [], calls: [] };
      const disabledTracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: false,
      });
      await disabledTracker.pollActiveOrders(nextPollTime());
      assert.equal(state.calls.length, 0);
      const noProviderTracker = createOrderTracker({
        db,
        provider: undefined,
        orderingEnabled: true,
      });
      const result = await noProviderTracker.pollActiveOrders(nextPollTime());
      assert.equal(result.affected, 0);
      await purgeFixtures();
    }

    // ---- 7. an order absent from history is never inferred as failed ----
    {
      const member = await createMember();
      const orderId = await createPlacedOrder(member.membershipId, member.householdId, 'ord-7');
      const state: FakeState = { orders: [], calls: [] };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      await tracker.pollActiveOrders(nextPollTime());
      const row = await getOrderRow(orderId);
      assert.equal(row!.status, 'placed');
      assert.equal(row!.providerStatus, null);
      assert.equal((await eventsFor(orderId)).length, 0);
      await purgeFixtures();
    }

    // ---- 8. overlapping polls never stack ----
    {
      const member = await createMember();
      await createPlacedOrder(member.membershipId, member.householdId, 'ord-8');
      let openGate: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      const state: FakeState = { orders: [], calls: [], gate };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      const first = tracker.pollActiveOrders(nextPollTime());
      const second = await tracker.pollActiveOrders(nextPollTime());
      assert.equal(second.affected, 0, 'a concurrent poll must be skipped, not stacked');
      openGate!();
      await first;
      assert.equal(state.calls.filter((call) => call.userId === member.userId).length, 1);
      await purgeFixtures();
    }

    // A slow request must remain exclusive after its short claim expires.
    {
      const member = await createMember();
      await createPlacedOrder(member.membershipId, member.householdId, 'ord-slow');
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let calls = 0;
      const provider = fakeProvider({ orders: [], calls: [] });
      provider.getOrders = async (userId) => {
        if (userId !== member.userId) return [];
        calls += 1;
        started();
        await gate;
        return [];
      };
      const firstTracker = createOrderTracker({ db, provider, orderingEnabled: true });
      const secondTracker = createOrderTracker({ db, provider, orderingEnabled: true });
      const claimTime = nextPollTime();
      const first = firstTracker.pollActiveOrders(claimTime);
      try {
        await entered;
        await secondTracker.pollActiveOrders(new Date(claimTime.getTime() + 6_000));
        assert.equal(calls, 1, 'a slow request remains locked after claim expiry');
      } finally {
        release();
        await first;
      }
      await secondTracker.pollActiveOrders(new Date(claimTime.getTime() + 20_000));
      assert.equal(calls, 2, 'completion releases the member lock');
      await purgeFixtures();
    }

    // ---- 9. a transient upstream error skips the member without crashing ----
    {
      const member = await createMember();
      const orderId = await createPlacedOrder(member.membershipId, member.householdId, 'ord-9');
      const state: FakeState = {
        orders: [],
        calls: [],
        error: new ProviderError('Swiggy MCP returned HTTP 503', 'upstream_error', 502),
      };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      const result = await tracker.pollActiveOrders(nextPollTime()); // must not throw
      assert.equal(result.affected, 0);
      const row = await getOrderRow(orderId);
      assert.equal(row!.status, 'placed');
      await purgeFixtures();
    }

    // ---- 10. a stale/out-of-order provider response never regresses the order ----
    {
      const member = await createMember();
      const orderId = await createPlacedOrder(member.membershipId, member.householdId, 'ord-10');
      const state: FakeState = { orders: [makeOrder('ord-10', 'out_for_delivery')], calls: [] };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      await tracker.pollActiveOrders(nextPollTime());
      assert.equal((await eventsFor(orderId)).length, 1);

      // A stale replica-style response (older observed status) must be
      // dropped: the order keeps its advanced observed status, emits no
      // duplicate event, and the status cannot regress.
      state.orders = [makeOrder('ord-10', 'confirmed')];
      const stale = await tracker.pollActiveOrders(nextPollTime());
      assert.equal(stale.affected, 0, 'a stale response must not count as a transition');
      const rowAfterStale = await getOrderRow(orderId);
      assert.equal(rowAfterStale!.providerStatus, 'out_for_delivery');
      assert.equal(rowAfterStale!.status, 'placed');
      assert.equal((await eventsFor(orderId)).length, 1);

      // Progression continues monotonically afterwards.
      state.orders = [makeOrder('ord-10', 'delivered')];
      const delivered = await tracker.pollActiveOrders(nextPollTime());
      assert.equal(delivered.affected, 1);
      const rowAfterDelivered = await getOrderRow(orderId);
      assert.equal(rowAfterDelivered!.status, 'delivered');
      const events = await eventsFor(orderId);
      assert.equal(events.length, 2);
      assert.equal(events[1]!.type, 'grocery_order.delivery_updated');
      await purgeFixtures();
    }

    // ---- 11. cross-instance polls claim work through the database lease ----
    {
      const member = await createMember();
      const orderId = await createPlacedOrder(member.membershipId, member.householdId, 'ord-11');
      const stateA: FakeState = { orders: [makeOrder('ord-11', 'confirmed')], calls: [] };
      const stateB: FakeState = { orders: [makeOrder('ord-11', 'confirmed')], calls: [] };
      const trackerA = createOrderTracker({
        db,
        provider: fakeProvider(stateA),
        orderingEnabled: true,
      });
      const trackerB = createOrderTracker({
        db,
        provider: fakeProvider(stateB),
        orderingEnabled: true,
      });
      // Two independent tracker instances (stand-ins for two replicas) poll at
      // the same instant: the database claim (FOR UPDATE SKIP LOCKED + the
      // tracked_at lease) must give the order to exactly one of them. Call
      // counts are scoped to this block's member — other test files running
      // against the same database may legitimately have eligible orders too.
      const callsForMember = (state: FakeState) =>
        state.calls.filter((call) => call.userId === member.userId).length;
      const fixedTime = new Date(now.getTime() + 1_000_000);
      const [resultA, resultB] = await Promise.all([
        trackerA.pollActiveOrders(fixedTime),
        trackerB.pollActiveOrders(fixedTime),
      ]);
      assert.equal(
        callsForMember(stateA) + callsForMember(stateB),
        1,
        'exactly one replica polls the order',
      );
      assert.equal(resultA.affected + resultB.affected, 1);
      const row = await getOrderRow(orderId);
      assert.equal(row!.providerStatus, 'confirmed');

      // The lease expires: a later poll re-claims the order (cadence intact).
      const later = await trackerA.pollActiveOrders(new Date(fixedTime.getTime() + 20_000));
      assert.equal(later.affected, 0, 'the same observed status must not re-emit');
      assert.equal(callsForMember(stateA) + callsForMember(stateB), 2);
      await purgeFixtures();
    }

    // ---- 12. the 100-order bound is fair: later orders are not starved ----
    {
      const member = await createMember();
      const orderIds: string[] = [];
      for (let i = 0; i < 150; i += 1) {
        orderIds.push(
          await createPlacedOrder(member.membershipId, member.householdId, `ord-12-${i}`),
        );
      }
      // Every order is in the provider history with a quiet status.
      const state: FakeState = {
        orders: orderIds.map((_, i) => makeOrder(`ord-12-${i}`, 'confirmed')),
        calls: [],
      };
      const tracker = createOrderTracker({
        db,
        provider: fakeProvider(state),
        orderingEnabled: true,
      });
      // Scoped to this block's household and member: other test files running
      // against the same database may have eligible orders that compete for
      // the same 100-row claim quota.
      const ourRows = () =>
        db.select().from(groceryOrders).where(eq(groceryOrders.householdId, member.householdId));
      const unattemptedIds = async () =>
        (await ourRows()).filter((r) => r.providerStatus === null).map((r) => r.id);

      // First poll: the claim is bounded — no more than 100 of ours can be
      // attempted in one cycle, even with the whole table eligible, and at
      // least 50 of ours must remain un-attempted (150 created, ≤100 claims).
      await tracker.pollActiveOrders(nextPollTime());
      const attemptedAfterFirst = (await ourRows()).filter((r) => r.providerStatus !== null).length;
      assert.ok(attemptedAfterFirst <= 100, 'the 100-order claim bound must hold');
      let unattempted = await unattemptedIds();
      assert.ok(unattempted.length >= 50, 'the bound must leave orders un-attempted');

      // Fairness: every poll claims never-attempted orders FIRST (tracked_at
      // NULLS FIRST), so the un-attempted ones are drained before any
      // attempted one is re-checked. A few polls at most, even if competing
      // rows from other suites share the quota.
      let guard = 0;
      while (unattempted.length > 0 && guard < 10) {
        await tracker.pollActiveOrders(nextPollTime());
        unattempted = await unattemptedIds();
        guard += 1;
      }
      assert.equal(unattempted.length, 0, 'no eligible order may stay starved');
      const memberPolls = state.calls.filter((call) => call.userId === member.userId).length;
      assert.equal(memberPolls, 1 + guard, 'one member session = one get_orders per poll');
      const eventCount = await db
        .select({ id: systemEvents.id })
        .from(systemEvents)
        .where(
          and(
            eq(systemEvents.entityType, 'grocery_order'),
            inArray(systemEvents.entityId, orderIds),
          ),
        );
      assert.equal(eventCount.length, 0, 'confirmed orders must not emit events');
      await purgeFixtures();
    }
  },
);
