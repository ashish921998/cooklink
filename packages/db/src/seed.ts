import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from './index.js';
import * as s from './schema.js';
import { generateStarterPlan, todayISO } from '@cooklink/domain';

/**
 * Seed a minimal local-dev Household: one owner, one cook, a few verified
 * recipes, and an active seven-day plan. Idempotent-ish: safe to run on an
 * empty database.
 *   pnpm db:seed
 */
async function main() {
  const db = createDatabase(process.env.DATABASE_URL);

  const existing = await db.select().from(s.users).limit(1);
  if (existing.length > 0) {
    console.log('Database already has data; skipping seed.');
    return;
  }

  const owner = await createUser(db, {
    clerkUserId: 'clerk-dev-owner',
    phone: '+919000000000',
    displayName: 'Demo Owner',
  });
  const cook = await createUser(db, {
    clerkUserId: 'clerk-dev-cook',
    phone: '+919000000001',
    displayName: 'Demo Cook',
  });
  const member = await createUser(db, {
    clerkUserId: 'clerk-dev-member',
    phone: '+919000000002',
    displayName: 'Demo Member',
  });
  const secondOwner = await createUser(db, {
    clerkUserId: 'clerk-dev-owner-two',
    phone: '+919000000003',
    displayName: 'Second Demo Owner',
  });

  const hid = randomUUID();
  await db.insert(s.households).values({
    id: hid,
    name: 'Sharma Home',
    servingCount: 4,
    mealStyle: 'north',
    dietStyle: 'vegetarian',
    healthEmphasis: [],
    specialMealEnabled: true,
    defaultLanguage: 'en',
  });
  await db.insert(s.memberships).values([
    {
      id: randomUUID(),
      userId: owner.id,
      householdId: hid,
      role: 'owner',
      status: 'active',
      notificationDefault: 'all',
    },
    {
      id: randomUUID(),
      userId: cook.id,
      householdId: hid,
      role: 'cook',
      status: 'active',
      notificationDefault: 'important',
    },
    {
      id: randomUUID(),
      userId: member.id,
      householdId: hid,
      role: 'member',
      status: 'active',
      notificationDefault: 'all',
    },
  ]);

  const dal = await createRecipe(db, {
    name: 'Dal Tadka',
    baseServings: 4,
    dietStyle: 'vegetarian',
    mealStyle: 'north',
    ingredients: [
      {
        name: 'Toor dal',
        ingredientKey: 'toor_dal',
        quantity: 200,
        unit: 'g',
        dependable: true,
        adjustToTaste: false,
      },
      {
        name: 'Tomato',
        ingredientKey: 'tomato',
        quantity: 3,
        unit: 'count',
        dependable: true,
        adjustToTaste: false,
      },
      {
        name: 'Salt',
        ingredientKey: null,
        quantity: null,
        unit: 'g',
        dependable: false,
        adjustToTaste: true,
      },
    ],
    steps: [
      'Boil dal with turmeric.',
      'Prepare tadka with cumin and garlic.',
      'Pour tadka over dal and serve.',
    ],
    mealTypes: ['lunch', 'dinner'],
  });

  const plan = generateStarterPlan(todayISO(), {
    dietStyle: 'vegetarian',
    mealStyle: 'north',
    servings: 4,
    specialMealEnabled: true,
  });
  await db.insert(s.plannedMeals).values(
    plan.map((m) => ({
      id: randomUUID(),
      householdId: hid,
      date: m.date,
      mealType: m.mealType,
      recipeId: m.mealType === 'dinner' ? dal.id : null,
      name: m.name,
      servings: m.servings,
      servingsOverridden: false,
      isSpecial: m.isSpecial,
      version: 1,
      updatedBy: null,
    })),
  );

  await db.insert(s.pantryLedger).values({
    id: randomUUID(),
    householdId: hid,
    ingredientKey: 'toor_dal',
    deltaG: 1000,
    deltaMl: null,
    deltaCount: null,
    source: 'order_delivered',
    perishable: false,
    freshnessDays: null,
    at: new Date(),
  });

  await db.insert(s.chatMessages).values({
    id: randomUUID(),
    householdId: hid,
    senderId: cook.id,
    kind: 'text',
    body: 'Please add tomatoes for tomorrow.',
    clientCreatedAt: new Date(),
  });
  await db.insert(s.groceryRequests).values({
    id: randomUUID(),
    householdId: hid,
    itemText: 'Tomatoes',
    quantityText: '1 kg',
    status: 'pending',
    createdById: cook.id,
  });

  const secondHouseholdId = randomUUID();
  await db.insert(s.households).values({
    id: secondHouseholdId,
    name: 'Rao Home',
    servingCount: 3,
    mealStyle: 'south',
    dietStyle: 'eggetarian',
    healthEmphasis: [],
    specialMealEnabled: false,
    defaultLanguage: 'hi',
  });
  await db.insert(s.memberships).values([
    {
      id: randomUUID(),
      userId: secondOwner.id,
      householdId: secondHouseholdId,
      role: 'owner',
      status: 'active',
      notificationDefault: 'all',
    },
    {
      id: randomUUID(),
      userId: cook.id,
      householdId: secondHouseholdId,
      role: 'cook',
      status: 'active',
      notificationDefault: 'important',
    },
  ]);
  const secondPlan = generateStarterPlan(todayISO(), {
    dietStyle: 'eggetarian',
    mealStyle: 'south',
    servings: 3,
    specialMealEnabled: false,
  });
  await db.insert(s.plannedMeals).values(
    secondPlan.map((meal) => ({
      id: randomUUID(),
      householdId: secondHouseholdId,
      ...meal,
      updatedBy: null,
    })),
  );
  await db.insert(s.chatMessages).values({
    id: randomUUID(),
    householdId: secondHouseholdId,
    senderId: secondOwner.id,
    kind: 'text',
    body: 'Breakfast at 8 tomorrow.',
    clientCreatedAt: new Date(),
  });
  await db.insert(s.groceryRequests).values({
    id: randomUUID(),
    householdId: secondHouseholdId,
    itemText: 'Curry leaves',
    quantityText: '1 bunch',
    status: 'approved',
    createdById: cook.id,
    resolvedById: secondOwner.id,
    resolvedAt: new Date(),
  });

  console.log(
    `Seeded isolated households ${hid} and ${secondHouseholdId} with ${plan.length + secondPlan.length} planned meals.`,
  );
}

async function createUser(
  db: Database,
  u: { clerkUserId: string; phone: string; displayName: string },
) {
  const id = randomUUID();
  await db
    .insert(s.users)
    .values({ id, clerkUserId: u.clerkUserId, phone: u.phone, displayName: u.displayName });
  const [row] = await db.select().from(s.users).where(eq(s.users.id, id));
  return row!;
}

async function createRecipe(
  db: Database,
  r: {
    name: string;
    baseServings: number;
    dietStyle: 'vegetarian' | 'eggetarian' | 'nonvegetarian';
    mealStyle: 'north' | 'south';
    ingredients: unknown[];
    steps: string[];
    mealTypes: string[];
  },
) {
  const id = randomUUID();
  await db.insert(s.recipes).values({
    id,
    name: r.name,
    baseServings: r.baseServings,
    ingredients: r.ingredients,
    steps: r.steps,
    provenance: 'verified',
    dietStyle: r.dietStyle,
    mealStyle: r.mealStyle,
    mealTypes: r.mealTypes,
  });
  const [row] = await db.select().from(s.recipes).where(eq(s.recipes.id, id));
  return row!;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
