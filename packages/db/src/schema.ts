import {
  mysqlTable,
  varchar,
  int,
  datetime,
  mysqlEnum,
  json,
  boolean,
  char,
  uniqueIndex,
  index,
  bigint,
  text,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

/**
 * Cooklink MySQL schema (PlanetScale, Mumbai — issue 07, AC#6).
 *
 * Design notes:
 * - All durable relational state lives here, unsharded at V1 (full ACID).
 * - There is NO row-level security. Every household-scoped read/write is
 *   scoped by `householdId` in the application server through the centralized
 *   authorization helpers in `@cooklink/domain`.
 * - Flexible payloads (meal metadata, intent suggestions) use JSON columns;
 *   the membership graph uses junction-style tables.
 * - Foreign-key constraints are intentionally omitted: PlanetScale/Vitess does
 *   not reliably enforce them, and integrity is owned by the application
 *   server. Every household_id is indexed for fast scoped queries.
 */

const id = () => char('id', { length: 36 }).primaryKey();
const now = () =>
  datetime('created_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP(3))`);

// ---- identity ----

export const users = mysqlTable(
  'users',
  {
    id: id(),
    clerkUserId: varchar('clerk_user_id', { length: 128 }).notNull(),
    phone: varchar('phone', { length: 32 }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    createdAt: now(),
  },
  (t) => ({ clerkIdx: uniqueIndex('clerkIdx').on(t.clerkUserId) }),
);

export const households = mysqlTable('households', {
  id: id(),
  name: varchar('name', { length: 128 }).notNull(),
  photoUrl: varchar('photo_url', { length: 512 }),
  servingCount: int('serving_count').notNull().default(4),
  mealStyle: mysqlEnum('meal_style', ['north', 'south']).notNull().default('north'),
  dietStyle: mysqlEnum('diet_style', ['vegetarian', 'eggetarian', 'nonvegetarian'])
    .notNull()
    .default('vegetarian'),
  healthEmphasis: json('health_emphasis').$type<string[]>().notNull().default([]),
  specialMealEnabled: boolean('special_meal_enabled').notNull().default(false),
  defaultLanguage: mysqlEnum('default_language', ['en', 'hi']).notNull().default('en'),
  createdAt: now(),
  closedAt: datetime('closed_at', { mode: 'date', fsp: 3 }),
});

export const memberships = mysqlTable(
  'memberships',
  {
    id: id(),
    userId: char('user_id', { length: 36 }).notNull(),
    householdId: char('household_id', { length: 36 }).notNull(),
    role: mysqlEnum('role', ['owner', 'member', 'cook']).notNull(),
    status: mysqlEnum('status', ['active', 'removed']).notNull().default('active'),
    notificationDefault: mysqlEnum('notification_default', ['all', 'important', 'muted'])
      .notNull()
      .default('all'),
    joinedAt: now(),
    removedAt: datetime('removed_at', { mode: 'date', fsp: 3 }),
  },
  (t) => ({
    householdIdx: index('householdIdx').on(t.householdId),
    userIdx: index('userIdx').on(t.userId),
    // A unique index on (userId, householdId, status) prevents two concurrent
    // invite acceptances from inserting duplicate active memberships for the
    // same person/household pair (one role per person/household). Removed
    // memberships are pruned before re-removal so the unique constraint holds.
    userHouseholdStatusIdx: uniqueIndex('userHouseholdStatusIdx').on(
      t.userId,
      t.householdId,
      t.status,
    ),
  }),
);

export const foodAvoidances = mysqlTable(
  'food_avoidances',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }),
    food: varchar('food', { length: 64 }).notNull(),
  },
  (t) => ({ householdIdx: index('householdIdx').on(t.householdId) }),
);

export const householdInvites = mysqlTable(
  'household_invites',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    role: mysqlEnum('role', ['member', 'cook']).notNull(),
    phoneHash: varchar('phone_hash', { length: 128 }).notNull(),
    token: varchar('token', { length: 64 }).notNull(),
    status: mysqlEnum('status', ['pending', 'accepted', 'revoked', 'expired'])
      .notNull()
      .default('pending'),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    acceptedByUserId: char('accepted_by_user_id', { length: 36 }),
    createdAt: now(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('tokenIdx').on(t.token),
    householdIdx: index('householdIdx').on(t.householdId),
  }),
);

// ---- meal plan + recipes ----

export const recipes = mysqlTable('recipes', {
  id: id(),
  name: varchar('name', { length: 128 }).notNull(),
  nameHi: varchar('name_hi', { length: 128 }),
  baseServings: int('base_servings').notNull().default(4),
  ingredients: json('ingredients').$type<unknown[]>().notNull(),
  steps: json('steps').$type<string[]>().notNull(),
  stepsHi: json('steps_hi').$type<string[]>(),
  provenance: mysqlEnum('provenance', ['verified', 'ai_draft']).notNull().default('verified'),
  dietStyle: mysqlEnum('diet_style', ['vegetarian', 'eggetarian', 'nonvegetarian']).notNull(),
  mealStyle: mysqlEnum('meal_style', ['north', 'south']),
  mealTypes: json('meal_types').$type<string[]>().notNull(),
});

export const plannedMeals = mysqlTable(
  'planned_meals',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    date: varchar('date', { length: 10 }).notNull(),
    mealType: mysqlEnum('meal_type', ['breakfast', 'lunch', 'dinner']).notNull(),
    recipeId: char('recipe_id', { length: 36 }),
    name: varchar('name', { length: 128 }).notNull(),
    servings: int('servings').notNull().default(4),
    servingsOverridden: boolean('servings_overridden').notNull().default(false),
    isSpecial: boolean('is_special').notNull().default(false),
    version: int('version').notNull().default(1),
    updatedBy: char('updated_by', { length: 36 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP(3))`),
  },
  (t) => ({
    slotIdx: uniqueIndex('slotIdx').on(t.householdId, t.date, t.mealType),
    householdDateIdx: index('householdDateIdx').on(t.householdId, t.date),
  }),
);

// ---- grocery ----

export const groceryRequests = mysqlTable(
  'grocery_requests',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    itemText: varchar('item_text', { length: 256 }).notNull(),
    quantityText: varchar('quantity_text', { length: 64 }),
    status: mysqlEnum('status', [
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'in_order',
      'fulfilled',
    ])
      .notNull()
      .default('pending'),
    createdById: char('created_by_id', { length: 36 }).notNull(),
    createdAt: now(),
    resolvedById: char('resolved_by_id', { length: 36 }),
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    version: int('version').notNull().default(1),
  },
  (t) => ({ householdStatusIdx: index('householdStatusIdx').on(t.householdId, t.status) }),
);

export const suggestedCartItems = mysqlTable(
  'suggested_cart_items',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    householdId: char('household_id', { length: 36 }).notNull(),
    ingredientKey: varchar('ingredient_key', { length: 64 }),
    groceryRequestId: char('grocery_request_id', { length: 36 }),
    freeTextItem: varchar('free_text_item', { length: 256 }),
    needDay: mysqlEnum('need_day', ['today', 'tomorrow', 'day_after']).notNull(),
    affectedMeals: json('affected_meals').$type<unknown[]>().notNull().default([]),
    confidence: mysqlEnum('confidence', ['likely_available', 'may_be_low', 'unknown']).notNull(),
    memberState: mysqlEnum('member_state', ['pending', 'kept', 'removed'])
      .notNull()
      .default('pending'),
    removalReason: mysqlEnum('removal_reason', ['already_have', 'not_needed', 'buy_later']),
  },
  (t) => ({ householdIdx: index('householdIdx').on(t.householdId) }),
);

export const pantryLedger = mysqlTable(
  'pantry_ledger',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    ingredientKey: varchar('ingredient_key', { length: 64 }).notNull(),
    deltaG: bigint('delta_g', { mode: 'number', unsigned: true }),
    deltaMl: bigint('delta_ml', { mode: 'number', unsigned: true }),
    deltaCount: int('delta_count'),
    source: mysqlEnum('source', [
      'order_delivered',
      'consumption',
      'request_override',
      'member_edit',
    ]).notNull(),
    perishable: boolean('perishable').notNull().default(false),
    freshnessDays: int('freshness_days'),
    at: datetime('at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => ({ householdKeyIdx: index('householdKeyIdx').on(t.householdId, t.ingredientKey) }),
);

export const groceryOrders = mysqlTable(
  'grocery_orders',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    placedById: char('placed_by_id', { length: 36 }).notNull(),
    providerOrderId: varchar('provider_order_id', { length: 128 }),
    status: mysqlEnum('status', ['pending', 'placed', 'failed', 'delivered'])
      .notNull()
      .default('pending'),
    totalCents: bigint('total_cents', { mode: 'number', unsigned: true }),
    createdAt: now(),
  },
  (t) => ({ householdIdx: index('householdIdx').on(t.householdId) }),
);

/**
 * A Member's chosen exact Instamart product for one Suggested Grocery Cart
 * line (issue 10, AC#3). A vague need stays unresolved until a product is
 * chosen. The product snapshot is stored as JSON so the review can show the
 * exact brand/variant/pack/price at selection time even if the provider's
 * catalog later changes.
 */
export const productMatches = mysqlTable(
  'product_matches',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    cartItemId: varchar('cart_item_id', { length: 128 }).notNull(),
    productId: varchar('product_id', { length: 128 }).notNull(),
    addressId: varchar('address_id', { length: 128 }).notNull(),
    quantity: int('quantity').notNull().default(1),
    product: json('product').$type<unknown>().notNull(),
    selectedById: char('selected_by_id', { length: 36 }).notNull(),
    selectedAt: now(),
  },
  (t) => ({
    householdCartIdx: uniqueIndex('householdCartIdx').on(t.householdId, t.cartItemId),
    householdIdx: index('productMatchHouseholdIdx').on(t.householdId),
  }),
);

// ---- chat ----

export const chatMessages = mysqlTable(
  'chat_messages',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    senderId: char('sender_id', { length: 36 }).notNull(),
    kind: mysqlEnum('kind', ['text', 'photo', 'voice']).notNull(),
    body: text('body'),
    caption: varchar('caption', { length: 512 }),
    mediaRef: varchar('media_ref', { length: 512 }),
    clientCreatedAt: datetime('client_created_at', { mode: 'date', fsp: 3 }).notNull(),
    serverCreatedAt: datetime('server_created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP(3))`),
    editedAt: datetime('edited_at', { mode: 'date', fsp: 3 }),
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
  },
  (t) => ({ householdServerIdx: index('householdServerIdx').on(t.householdId, t.serverCreatedAt) }),
);

export const voiceTranscripts = mysqlTable('voice_transcripts', {
  messageId: char('message_id', { length: 36 }).primaryKey(),
  language: mysqlEnum('language', ['en', 'hi']),
  transcript: text('transcript'),
  status: mysqlEnum('status', ['pending', 'ready', 'failed']).notNull().default('pending'),
  correctedTranscript: text('corrected_transcript'),
});

export const systemEvents = mysqlTable(
  'system_events',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    type: varchar('type', { length: 48 }).notNull(),
    actorId: char('actor_id', { length: 36 }),
    entityType: varchar('entity_type', { length: 48 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }).notNull(),
    // Safe rendering payload — NEVER money (issue 06, AC#24).
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP(3))`),
  },
  (t) => ({ householdCreatedIdx: index('householdCreatedIdx').on(t.householdId, t.createdAt) }),
);

export const actionSuggestions = mysqlTable(
  'action_suggestions',
  {
    id: id(),
    householdId: char('household_id', { length: 36 }).notNull(),
    authorId: char('author_id', { length: 36 }).notNull(),
    sourceMessageId: char('source_message_id', { length: 36 }),
    intent: json('intent').$type<unknown>().notNull(),
    status: mysqlEnum('status', ['pending', 'confirmed', 'dismissed', 'expired', 'failed'])
      .notNull()
      .default('pending'),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: now(),
  },
  (t) => ({
    authorIdx: index('authorIdx').on(t.authorId, t.status),
    householdIdx: index('householdIdx').on(t.householdId),
  }),
);

export const householdMemberState = mysqlTable(
  'household_member_state',
  {
    userId: char('user_id', { length: 36 }).notNull(),
    householdId: char('household_id', { length: 36 }).notNull(),
    lastReadMessageId: char('last_read_message_id', { length: 36 }),
    notificationOverride: mysqlEnum('notification_override', ['all', 'important', 'muted']),
  },
  (t) => ({ memberStateIdx: uniqueIndex('memberStateIdx').on(t.userId, t.householdId) }),
);

export const deviceRegistrations = mysqlTable(
  'device_registrations',
  {
    id: id(),
    userId: char('user_id', { length: 36 }).notNull(),
    pushToken: varchar('push_token', { length: 256 }).notNull(),
    platform: mysqlEnum('platform', ['ios', 'android']).notNull(),
    hidePreviews: boolean('hide_previews').notNull().default(false),
    lastSuccessAt: datetime('last_success_at', { mode: 'date', fsp: 3 }),
    invalidatedAt: datetime('invalidated_at', { mode: 'date', fsp: 3 }),
  },
  (t) => ({ tokenIdx: uniqueIndex('tokenIdx').on(t.pushToken) }),
);

// ---- ordering (server-side only; per-member encrypted OAuth) ----

export const swiggyTokens = mysqlTable('swiggy_tokens', {
  userId: char('user_id', { length: 36 }).primaryKey(),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP(3))`),
});

export const idempotencyKeys = mysqlTable('idempotency_keys', {
  key: varchar('key', { length: 128 }).primaryKey(),
  membershipId: char('membership_id', { length: 36 }).notNull(),
  householdId: char('household_id', { length: 36 }).notNull(),
  status: mysqlEnum('status', ['in_flight', 'succeeded', 'failed']).notNull().default('in_flight'),
  result: json('result').$type<unknown>(),
  createdAt: now(),
});

/** Append-only checkout audit (issue 07, AC#19). */
export const checkoutAudit = mysqlTable(
  'checkout_audit',
  {
    id: id(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    householdId: char('household_id', { length: 36 }).notNull(),
    cartTotalCents: bigint('cart_total_cents', { mode: 'number', unsigned: true }),
    paymentMethod: varchar('payment_method', { length: 64 }),
    result: varchar('result', { length: 64 }).notNull(),
    verifiedViaGetOrders: boolean('verified_via_get_orders').notNull().default(false),
    createdAt: now(),
  },
  (t) => ({ householdIdx: index('householdIdx').on(t.householdId) }),
);
