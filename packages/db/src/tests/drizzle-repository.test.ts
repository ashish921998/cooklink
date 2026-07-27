import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, DrizzleRepository } from '../index.js';
import { id } from '@cooklink/domain';

const databaseUrl = process.env.DATABASE_URL;

test(
  'DrizzleRepository isolates durable household reads and writes',
  { skip: databaseUrl ? false : 'DATABASE_URL is required for MySQL integration tests' },
  async () => {
    const repo = new DrizzleRepository(createDatabase(databaseUrl));
    const suffix = crypto.randomUUID();
    const userA = await repo.createUser({
      id: id<'UserId'>(crypto.randomUUID()),
      clerkUserId: `repo-a-${suffix}`,
      phone: '+919100000001',
      displayName: 'Repo A',
    });
    const userB = await repo.createUser({
      id: id<'UserId'>(crypto.randomUUID()),
      clerkUserId: `repo-b-${suffix}`,
      phone: '+919100000002',
      displayName: 'Repo B',
    });
    const householdA = await repo.createHousehold(household('Durable A'), userA.id);
    const householdB = await repo.createHousehold(household('Durable B'), userB.id);

    await repo.createMessage(householdA.household.id, {
      senderId: householdA.ownerMembership.id,
      kind: 'text',
      body: 'A-only message',
      caption: null,
      mediaRef: null,
      clientCreatedAt: new Date().toISOString(),
    });

    assert.equal((await repo.getChatTimeline(householdA.household.id, null, 20)).length, 1);
    assert.equal((await repo.getChatTimeline(householdB.household.id, null, 20)).length, 0);
  },
);

test(
  'DrizzleRepository creates grocery request and system event atomically',
  { skip: databaseUrl ? false : 'DATABASE_URL is required for MySQL integration tests' },
  async () => {
    const repo = new DrizzleRepository(createDatabase(databaseUrl));
    const suffix = crypto.randomUUID();
    const user = await repo.createUser({
      id: id<'UserId'>(crypto.randomUUID()),
      clerkUserId: `repo-tx-${suffix}`,
      phone: '+919100000003',
      displayName: 'Repo Tx',
    });
    const { household: created, ownerMembership } = await repo.createHousehold(
      household('Durable Tx'),
      user.id,
    );

    const { request, event } = await repo.createGroceryRequest(
      created.id,
      { itemText: 'Tomatoes', quantityText: '1 kg' },
      ownerMembership.id,
    );
    const timeline = await repo.getChatTimeline(created.id, null, 20);

    assert.equal(request.householdId, created.id);
    assert.equal(event.householdId, created.id);
    assert.equal(
      timeline.some((item) => item.kind === 'event' && item.event.id === event.id),
      true,
    );
  },
);

function household(name: string) {
  return {
    name,
    photoUrl: null,
    servingCount: 4,
    mealStyle: 'north' as const,
    dietStyle: 'vegetarian' as const,
    healthEmphasis: [],
    specialMealEnabled: false,
    defaultLanguage: 'en' as const,
  };
}
