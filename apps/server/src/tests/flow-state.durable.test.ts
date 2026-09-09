import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq, inArray, like } from 'drizzle-orm';
import {
  createDatabase,
  checkoutConfirmations,
  households,
  memberships,
  swiggyOAuthCallbacks,
  swiggyOAuthPending,
  swiggyRecentProducts,
  users,
} from '@cooklink/db';
import { brandId, ProviderError, type UserId } from '@cooklink/domain';
import {
  createDatabaseConfirmationStore,
  createDatabaseOAuthCallbackStore,
  createDatabasePendingOAuthStore,
  createDatabaseProductCacheStore,
} from '../flow-state.js';
import { createSwiggyProvider, type SwiggyTokenStore } from '../provider-swiggy.js';

/**
 * Durable Swiggy flow state (issue 13 — no process-local ordering state).
 *
 * Postgres-backed tests over an isolated database. Every store is created
 * twice (as two independent instances would) to prove the flows recover
 * across instances and restarts. Covers: cross-instance recovery, expiry,
 * replay denial, and cross-user denial. Skipped without DATABASE_URL.
 */

const testDbUrl = process.env.DATABASE_URL;

// Test-only key: a well-formed base64 32-byte value, never a real credential.
const TEST_KEY = Buffer.from(
  'cooklink-test-key-0000000000000000'.slice(0, 32).padEnd(32, '0'),
).toString('base64');

test(
  'durable flow state: cross-instance recovery, expiry, replay, cross-user denial',
  { skip: testDbUrl ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const db = createDatabase(testDbUrl);

    /**
     * Purge every fixture row this test family ever created (marked by the
     * `flow-state-` Clerk-id prefix and the fixed household name), so fixed
     * primary keys (`state-durable-1`, `cf-durable-1`, …) never collide with
     * a previous run against a persistent development database.
     */
    async function purgeFixtures(): Promise<void> {
      const householdIds = (
        await db
          .select({ id: households.id })
          .from(households)
          .where(eq(households.name, 'Flow State Test'))
      ).map((row) => row.id);
      if (householdIds.length > 0) {
        await db
          .delete(checkoutConfirmations)
          .where(inArray(checkoutConfirmations.householdId, householdIds));
        await db.delete(memberships).where(inArray(memberships.householdId, householdIds));
        await db.delete(households).where(inArray(households.id, householdIds));
      }
      const userIds = (
        await db.select({ id: users.id }).from(users).where(like(users.clerkUserId, 'flow-state-%'))
      ).map((row) => row.id);
      if (userIds.length > 0) {
        await db.delete(swiggyOAuthPending).where(inArray(swiggyOAuthPending.userId, userIds));
        await db.delete(swiggyOAuthCallbacks).where(inArray(swiggyOAuthCallbacks.userId, userIds));
        await db.delete(swiggyRecentProducts).where(inArray(swiggyRecentProducts.userId, userIds));
        await db.delete(users).where(inArray(users.id, userIds));
      }
    }

    await purgeFixtures();

    async function createMember(): Promise<{
      userId: UserId;
      membershipId: string;
      householdId: string;
    }> {
      const userId = randomUUID();
      const householdId = randomUUID();
      const membershipId = randomUUID();
      await db.insert(users).values({
        id: userId,
        clerkUserId: `flow-state-${userId}`,
        phone: `+9198${userId.replaceAll('-', '').slice(0, 8)}`,
        displayName: 'Flow State Test',
      });
      await db.insert(households).values({ id: householdId, name: 'Flow State Test' });
      await db
        .insert(memberships)
        .values({ id: membershipId, userId, householdId, role: 'owner', status: 'active' });
      return { userId: brandId<'UserId'>(userId), membershipId, householdId };
    }

    // ---- pending OAuth (PKCE): cross-instance recovery + replay denial ----
    {
      const member = await createMember();
      // Two "instances" sharing the database, as a deploy mid-sign-in would.
      const instanceA = createDatabasePendingOAuthStore(db, TEST_KEY);
      const instanceB = createDatabasePendingOAuthStore(db, TEST_KEY);

      const startedAt = Date.now();
      await instanceA.save(
        'state-durable-1',
        {
          userId: member.userId,
          redirectUri: 'https://api.cooklink.app/oauth/swiggy/callback',
          clientId: 'dcr-client',
          clientSecret: 'client-secret-value',
          codeVerifier: 'pkce-code-verifier-value',
          createdAt: startedAt,
        },
        10 * 60_000,
      );

      // Encrypted at rest: the verifier and secret must not be readable rows.
      const [row] = await db
        .select()
        .from(swiggyOAuthPending)
        .where(eq(swiggyOAuthPending.state, 'state-durable-1'))
        .limit(1);
      assert.ok(row);
      assert.ok(!row.encryptedCodeVerifier.includes('pkce-code-verifier-value'));
      assert.ok(!row.encryptedClientSecret!.includes('client-secret-value'));

      // Another instance consumes it — cross-instance recovery.
      const pending = await instanceB.consume('state-durable-1');
      assert.ok(pending);
      assert.equal(pending.codeVerifier, 'pkce-code-verifier-value');
      assert.equal(pending.clientSecret, 'client-secret-value');
      assert.equal(pending.userId, member.userId);

      // Replay (on either instance) fails closed.
      assert.equal(await instanceA.consume('state-durable-1'), null);
      assert.equal(await instanceB.consume('state-durable-1'), null);

      // Expiry: a state older than its TTL is rejected and swept.
      await instanceA.save(
        'state-expired',
        {
          userId: member.userId,
          redirectUri: 'https://api.cooklink.app/oauth/swiggy/callback',
          clientId: 'dcr-client',
          clientSecret: null,
          codeVerifier: 'expired-verifier',
          createdAt: Date.now() - 20 * 60_000,
        },
        10 * 60_000,
      );
      assert.equal(await instanceB.consume('state-expired'), null);
    }

    // ---- browser-callback routing: cross-instance + single-use + expiry ----
    {
      const member = await createMember();
      const instanceA = createDatabaseOAuthCallbackStore(db);
      const instanceB = createDatabaseOAuthCallbackStore(db);

      await instanceA.save(
        'cb-durable-1',
        { userId: member.userId, appReturnUri: 'cooklink://swiggy' },
        10 * 60_000,
      );
      const consumed = await instanceB.consume('cb-durable-1');
      assert.ok(consumed);
      assert.equal(consumed.userId, member.userId);
      assert.equal(consumed.appReturnUri, 'cooklink://swiggy');
      assert.equal(await instanceA.consume('cb-durable-1'), null, 'a callback must be single-use');

      await instanceA.save(
        'cb-expired',
        { userId: member.userId, appReturnUri: 'cooklink://swiggy' },
        -1,
      );
      assert.equal(await instanceB.consume('cb-expired'), null);
    }

    // ---- checkout confirmations: cross-instance, replay, expiry, cross-user ----
    {
      const owner = await createMember();
      const other = await createMember();
      const instanceA = createDatabaseConfirmationStore(db);
      const instanceB = createDatabaseConfirmationStore(db);

      const confirmation = {
        token: 'cf-durable-1',
        householdId: brandId<'HouseholdId'>(owner.householdId),
        membershipId: brandId<'MembershipId'>(owner.membershipId),
        addressId: 'addr-home',
        paymentMethodId: 'pm-cod',
        storeCount: 1,
        totalCents: 12_600,
        itemCount: 2,
        cartSignature: 'prod-tomato-500:2',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      await instanceA.issue(confirmation);

      // Cross-user denial: a different member can neither use nor destroy it.
      const wrongMember = await instanceB.consume(
        'cf-durable-1',
        brandId<'MembershipId'>(other.membershipId),
      );
      assert.ok(wrongMember && wrongMember.kind === 'membership_mismatch');

      // The rightful owner consumes it from ANOTHER instance — recovery.
      const consumed = await instanceB.consume('cf-durable-1', confirmation.membershipId);
      assert.ok(consumed && consumed.kind === 'consumed');
      assert.equal(consumed.confirmation.totalCents, 12_600);
      assert.equal(consumed.confirmation.cartSignature, 'prod-tomato-500:2');

      // Replay: the token is spent, on every instance.
      const replay = await instanceA.consume('cf-durable-1', confirmation.membershipId);
      assert.equal(replay, null);

      // Expiry: an expired confirmation fails closed.
      await instanceA.issue({
        ...confirmation,
        token: 'cf-expired',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      const expired = await instanceB.consume('cf-expired', confirmation.membershipId);
      assert.equal(expired, null);
    }

    // ---- recent-product cache: cross-instance recovery + per-user isolation ----
    {
      const member = await createMember();
      const instanceA = createDatabaseProductCacheStore(db);
      const instanceB = createDatabaseProductCacheStore(db);

      await instanceA.remember(member.userId, [
        {
          id: 'spin-tomato',
          skuId: 'sku-tomato',
          name: 'Tomato',
          brand: 'Fresh Farms',
          variant: 'Ripe',
          packSize: '500 g',
          priceCents: 3000,
          mrpCents: 3500,
          available: true,
          addressId: 'addr-home',
          storeId: 'store-1',
          storeName: 'Instamart Store 1',
          imageUrl: null,
          similar: false,
        },
      ]);
      const cached = await instanceB.get(member.userId, 'spin-tomato');
      assert.ok(cached);
      assert.equal(cached.name, 'Tomato');
      assert.equal(await instanceB.get(member.userId, 'spin-absent'), null);

      // Disconnect clears the member's cache.
      await instanceA.clear(member.userId);
      assert.equal(await instanceB.get(member.userId, 'spin-tomato'), null);
      const [remaining] = await db
        .select()
        .from(swiggyRecentProducts)
        .where(eq(swiggyRecentProducts.userId, member.userId as string))
        .limit(1);
      assert.equal(remaining, undefined);
    }

    // ---- the real provider consumes durable pending OAuth exactly once ----
    {
      const member = await createMember();
      const tokens = new Map<string, { accessToken: string; expiresAt: Date }>();
      const tokenStore: SwiggyTokenStore = {
        async get(userId) {
          return tokens.get(userId as string) ?? null;
        },
        async set(userId, token) {
          tokens.set(userId as string, token);
        },
        async delete(userId) {
          tokens.delete(userId as string);
        },
      };
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith('/auth/register')) return Response.json({ client_id: 'dcr-client' });
        if (url.endsWith('/auth/token')) {
          return Response.json({ access_token: 'test-access-token', expires_in: 432_000 });
        }
        throw new Error(`unexpected fetch ${url}`);
      };

      const providerOnA = createSwiggyProvider({
        tokenStore,
        fetchImpl,
        pendingOAuthStore: createDatabasePendingOAuthStore(db, TEST_KEY),
      });
      const started = await providerOnA.startOAuth({
        memberUserId: member.userId,
        redirectUri: 'https://api.cooklink.app/oauth/swiggy/callback',
      });

      // A different member presenting the same state is denied and does not
      // exchange the code.
      const providerOnB = createSwiggyProvider({
        tokenStore,
        fetchImpl,
        pendingOAuthStore: createDatabasePendingOAuthStore(db, TEST_KEY),
      });
      await assert.rejects(
        () =>
          providerOnB.completeOAuth({
            memberUserId: brandId<'UserId'>(randomUUID()),
            code: 'oauth-code',
            state: started.state,
          }),
        (err: unknown) => err instanceof ProviderError && err.code === 'expired_session',
      );

      // The rightful member completes on the other instance; a replay of the
      // same state cannot exchange the code again.
      await providerOnB.completeOAuth({
        memberUserId: member.userId,
        code: 'oauth-code',
        state: started.state,
      });
      assert.equal((await providerOnB.getConnectionStatus(member.userId)).connected, true);
      await assert.rejects(
        () =>
          providerOnA.completeOAuth({
            memberUserId: member.userId,
            code: 'oauth-code-2',
            state: started.state,
          }),
        (err: unknown) => err instanceof ProviderError && err.code === 'expired_session',
      );
      // The wrong-member attempt above did not burn the state for its owner:
      // ownership was checked against the acting user, and the owner's own
      // completion succeeded.
    }
  },
);
