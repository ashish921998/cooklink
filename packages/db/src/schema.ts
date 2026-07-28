import {
  pgTable,
  varchar,
  integer,
  timestamp,
  pgEnum,
  jsonb,
  boolean,
  uuid,
  uniqueIndex,
  index,
  bigint,
  text,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Cooklink PostgreSQL schema (PlanetScale Postgres, Mumbai — issue 07, AC#6).
 *
 * Design notes:
 * - All durable relational state lives here, unsharded at V1 (full ACID).
 * - There is NO row-level security. Every household-scoped read/write is
 *   scoped by `householdId` in the application server through the centralized
 *   authorization helpers in `@cooklink/domain`.
 * - Flexible payloads (meal metadata, intent suggestions) use JSONB columns;
 *   the membership graph uses junction-style tables.
 * - Foreign-key constraints are added where the child row's lifetime is
 *   bounded by the parent row's lifetime (users and households are never
 *   hard-deleted; chat messages use soft-delete). FKs to `memberships` are
 *   intentionally omitted because membership rows can be hard-pruned during
 *   re-invite flows, and child rows (chat messages, system events, etc.)
 *   must survive that pruning. Every household_id is indexed for fast scoped
 *   queries.
 */

const id = () => uuid('id').primaryKey();
const now = () =>
  timestamp('created_at', { mode: 'date', withTimezone: true })
    .notNull()
    .default(sql`now()`);

// ---- shared enum types (one per domain concept) ----

export const mealStyleEnum = pgEnum('meal_style', ['north', 'south']);
export const dietStyleEnum = pgEnum('diet_style', ['vegetarian', 'eggetarian', 'nonvegetarian']);
export const languageEnum = pgEnum('language', ['en', 'hi']);
export const membershipRoleEnum = pgEnum('membership_role', ['owner', 'member', 'cook']);
export const inviteRoleEnum = pgEnum('invite_role', ['member', 'cook']);
export const membershipStatusEnum = pgEnum('membership_status', ['active', 'removed']);
export const notificationLevelEnum = pgEnum('notification_level', ['all', 'important', 'muted']);
export const provenanceEnum = pgEnum('provenance', ['verified', 'ai_draft']);
export const mealTypeEnum = pgEnum('meal_type', ['breakfast', 'lunch', 'dinner']);
export const groceryRequestStatusEnum = pgEnum('grocery_request_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'in_order',
  'fulfilled',
]);
export const needDayEnum = pgEnum('need_day', ['today', 'tomorrow', 'day_after']);
export const confidenceEnum = pgEnum('confidence', ['likely_available', 'may_be_low', 'unknown']);
export const cartMemberStateEnum = pgEnum('cart_member_state', ['pending', 'kept', 'removed']);
export const removalReasonEnum = pgEnum('removal_reason', [
  'already_have',
  'not_needed',
  'buy_later',
]);
export const pantrySourceEnum = pgEnum('pantry_source', [
  'order_delivered',
  'consumption',
  'request_override',
  'member_edit',
]);
export const groceryOrderStatusEnum = pgEnum('grocery_order_status', [
  'pending',
  'placed',
  'failed',
  'delivered',
]);
export const chatKindEnum = pgEnum('chat_kind', ['text', 'photo', 'voice']);
export const transcriptStatusEnum = pgEnum('transcript_status', ['pending', 'ready', 'failed']);
export const inviteStatusEnum = pgEnum('invite_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);
export const suggestionStatusEnum = pgEnum('suggestion_status', [
  'pending',
  'confirmed',
  'dismissed',
  'expired',
  'failed',
]);
export const idempotencyStatusEnum = pgEnum('idempotency_status', [
  'in_flight',
  'succeeded',
  'failed',
]);
export const devicePlatformEnum = pgEnum('device_platform', ['ios', 'android']);

// ---- identity ----

export const users = pgTable(
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

export const households = pgTable('households', {
  id: id(),
  name: varchar('name', { length: 128 }).notNull(),
  photoUrl: varchar('photo_url', { length: 512 }),
  servingCount: integer('serving_count').notNull().default(4),
  mealStyle: mealStyleEnum('meal_style').notNull().default('north'),
  dietStyle: dietStyleEnum('diet_style').notNull().default('vegetarian'),
  healthEmphasis: jsonb('health_emphasis').$type<string[]>().notNull().default([]),
  specialMealEnabled: boolean('special_meal_enabled').notNull().default(false),
  defaultLanguage: languageEnum('default_language').notNull().default('en'),
  createdAt: now(),
  closedAt: timestamp('closed_at', { mode: 'date', withTimezone: true }),
});

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    householdId: uuid('household_id').notNull(),
    role: membershipRoleEnum('role').notNull(),
    status: membershipStatusEnum('status').notNull().default('active'),
    notificationDefault: notificationLevelEnum('notification_default').notNull().default('all'),
    joinedAt: now(),
    removedAt: timestamp('removed_at', { mode: 'date', withTimezone: true }),
  },
  (t) => ({
    householdIdx: index('membershipsHouseholdIdx').on(t.householdId),
    userIdx: index('userIdx').on(t.userId),
    userHouseholdStatusIdx: uniqueIndex('userHouseholdStatusIdx').on(
      t.userId,
      t.householdId,
      t.status,
    ),
    userFk: foreignKey({ columns: [t.userId], foreignColumns: [users.id] }),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
  }),
);

export const foodAvoidances = pgTable(
  'food_avoidances',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id'),
    food: varchar('food', { length: 64 }).notNull(),
  },
  (t) => ({
    householdIdx: index('foodAvoidancesHouseholdIdx').on(t.householdId),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    userFk: foreignKey({ columns: [t.userId], foreignColumns: [users.id] }),
  }),
);

export const householdInvites = pgTable(
  'household_invites',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    role: inviteRoleEnum('role').notNull(),
    phoneHash: varchar('phone_hash', { length: 128 }).notNull(),
    token: varchar('token', { length: 64 }).notNull(),
    status: inviteStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    acceptedByUserId: uuid('accepted_by_user_id'),
    createdAt: now(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('inviteTokenIdx').on(t.token),
    householdIdx: index('invitesHouseholdIdx').on(t.householdId),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    acceptedByUserFk: foreignKey({ columns: [t.acceptedByUserId], foreignColumns: [users.id] }),
  }),
);

// ---- meal plan + recipes ----

export const recipes = pgTable('recipes', {
  id: id(),
  name: varchar('name', { length: 128 }).notNull(),
  nameHi: varchar('name_hi', { length: 128 }),
  baseServings: integer('base_servings').notNull().default(4),
  ingredients: jsonb('ingredients').$type<unknown[]>().notNull(),
  steps: jsonb('steps').$type<string[]>().notNull(),
  stepsHi: jsonb('steps_hi').$type<string[]>(),
  provenance: provenanceEnum('provenance').notNull().default('verified'),
  dietStyle: dietStyleEnum('diet_style').notNull(),
  mealStyle: mealStyleEnum('meal_style'),
  mealTypes: jsonb('meal_types').$type<string[]>().notNull(),
});

export const plannedMeals = pgTable(
  'planned_meals',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    date: varchar('date', { length: 10 }).notNull(),
    mealType: mealTypeEnum('meal_type').notNull(),
    recipeId: uuid('recipe_id'),
    name: varchar('name', { length: 128 }).notNull(),
    servings: integer('servings').notNull().default(4),
    servingsOverridden: boolean('servings_overridden').notNull().default(false),
    isSpecial: boolean('is_special').notNull().default(false),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    slotIdx: uniqueIndex('slotIdx').on(t.householdId, t.date, t.mealType),
    householdDateIdx: index('householdDateIdx').on(t.householdId, t.date),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    recipeFk: foreignKey({ columns: [t.recipeId], foreignColumns: [recipes.id] }),
  }),
);

// ---- grocery ----

export const groceryRequests = pgTable(
  'grocery_requests',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    itemText: varchar('item_text', { length: 256 }).notNull(),
    quantityText: varchar('quantity_text', { length: 64 }),
    status: groceryRequestStatusEnum('status').notNull().default('pending'),
    createdById: uuid('created_by_id').notNull(),
    createdAt: now(),
    resolvedById: uuid('resolved_by_id'),
    resolvedAt: timestamp('resolved_at', { mode: 'date', withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (t) => ({
    householdStatusIdx: index('householdStatusIdx').on(t.householdId, t.status),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
  }),
);

export const suggestedCartItems = pgTable(
  'suggested_cart_items',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    householdId: uuid('household_id').notNull(),
    ingredientKey: varchar('ingredient_key', { length: 64 }),
    groceryRequestId: uuid('grocery_request_id'),
    freeTextItem: varchar('free_text_item', { length: 256 }),
    needDay: needDayEnum('need_day').notNull(),
    affectedMeals: jsonb('affected_meals').$type<unknown[]>().notNull().default([]),
    confidence: confidenceEnum('confidence').notNull(),
    memberState: cartMemberStateEnum('member_state').notNull().default('pending'),
    removalReason: removalReasonEnum('removal_reason'),
  },
  (t) => ({
    householdIdx: index('suggestedCartHouseholdIdx').on(t.householdId),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    groceryRequestFk: foreignKey({
      columns: [t.groceryRequestId],
      foreignColumns: [groceryRequests.id],
    }),
  }),
);

export const pantryLedger = pgTable(
  'pantry_ledger',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    ingredientKey: varchar('ingredient_key', { length: 64 }).notNull(),
    // Signed integers: consumption entries may carry negative deltas (the
    // prior MySQL `unsigned` constraint was a semantic mismatch — issue 09
    // consumption reduces pantry stock).
    deltaG: integer('delta_g'),
    deltaMl: integer('delta_ml'),
    deltaCount: integer('delta_count'),
    source: pantrySourceEnum('source').notNull(),
    perishable: boolean('perishable').notNull().default(false),
    freshnessDays: integer('freshness_days'),
    at: timestamp('at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (t) => ({
    householdKeyIdx: index('householdKeyIdx').on(t.householdId, t.ingredientKey),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
  }),
);

export const groceryOrders = pgTable(
  'grocery_orders',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    placedById: uuid('placed_by_id').notNull(),
    providerOrderId: varchar('provider_order_id', { length: 128 }),
    status: groceryOrderStatusEnum('status').notNull().default('pending'),
    totalCents: bigint('total_cents', { mode: 'number' }),
    createdAt: now(),
  },
  (t) => ({
    householdIdx: index('groceryOrdersHouseholdIdx').on(t.householdId),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    totalCentsCheck: check('grocery_orders_total_cents_nonneg', sql`${t.totalCents} >= 0`),
  }),
);

/**
 * A Member's chosen exact Instamart product for one Suggested Grocery Cart
 * line (issue 10, AC#3). A vague need stays unresolved until a product is
 * chosen. The product snapshot is stored as JSONB so the review can show the
 * exact brand/variant/pack/price at selection time even if the provider's
 * catalog later changes.
 */
export const productMatches = pgTable(
  'product_matches',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    cartItemId: varchar('cart_item_id', { length: 128 }).notNull(),
    productId: varchar('product_id', { length: 128 }).notNull(),
    addressId: varchar('address_id', { length: 128 }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    product: jsonb('product').$type<unknown>().notNull(),
    selectedById: uuid('selected_by_id').notNull(),
    selectedAt: now(),
  },
  (t) => ({
    householdCartIdx: uniqueIndex('householdCartIdx').on(t.householdId, t.cartItemId),
    householdIdx: index('productMatchHouseholdIdx').on(t.householdId),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
  }),
);

// ---- chat ----

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    senderId: uuid('sender_id').notNull(),
    kind: chatKindEnum('kind').notNull(),
    body: text('body'),
    caption: varchar('caption', { length: 512 }),
    mediaRef: varchar('media_ref', { length: 512 }),
    clientCreatedAt: timestamp('client_created_at', { mode: 'date', withTimezone: true }).notNull(),
    serverCreatedAt: timestamp('server_created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .default(sql`now()`),
    editedAt: timestamp('edited_at', { mode: 'date', withTimezone: true }),
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
  },
  (t) => ({
    householdServerIdx: index('householdServerIdx').on(t.householdId, t.serverCreatedAt),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
  }),
);

export const voiceTranscripts = pgTable(
  'voice_transcripts',
  {
    messageId: uuid('message_id').primaryKey(),
    language: languageEnum('language'),
    transcript: text('transcript'),
    status: transcriptStatusEnum('status').notNull().default('pending'),
    correctedTranscript: text('corrected_transcript'),
  },
  (t) => ({
    messageFk: foreignKey({ columns: [t.messageId], foreignColumns: [chatMessages.id] }),
  }),
);

export const systemEvents = pgTable(
  'system_events',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    type: varchar('type', { length: 48 }).notNull(),
    actorId: uuid('actor_id'),
    entityType: varchar('entity_type', { length: 48 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }).notNull(),
    // Safe rendering payload — NEVER money (issue 06, AC#24).
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    householdCreatedIdx: index('householdCreatedIdx').on(t.householdId, t.createdAt),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
  }),
);

export const actionSuggestions = pgTable(
  'action_suggestions',
  {
    id: id(),
    householdId: uuid('household_id').notNull(),
    authorId: uuid('author_id').notNull(),
    sourceMessageId: uuid('source_message_id'),
    intent: jsonb('intent').$type<unknown>().notNull(),
    status: suggestionStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (t) => ({
    authorIdx: index('authorIdx').on(t.authorId, t.status),
    householdIdx: index('suggestionsHouseholdIdx').on(t.householdId),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    sourceMessageFk: foreignKey({
      columns: [t.sourceMessageId],
      foreignColumns: [chatMessages.id],
    }),
  }),
);

export const householdMemberState = pgTable(
  'household_member_state',
  {
    userId: uuid('user_id').notNull(),
    householdId: uuid('household_id').notNull(),
    lastReadMessageId: uuid('last_read_message_id'),
    notificationOverride: notificationLevelEnum('notification_override'),
  },
  (t) => ({
    memberStateIdx: uniqueIndex('memberStateIdx').on(t.userId, t.householdId),
    userFk: foreignKey({ columns: [t.userId], foreignColumns: [users.id] }),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    lastReadMessageFk: foreignKey({
      columns: [t.lastReadMessageId],
      foreignColumns: [chatMessages.id],
    }),
  }),
);

export const deviceRegistrations = pgTable(
  'device_registrations',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    pushToken: varchar('push_token', { length: 256 }).notNull(),
    platform: devicePlatformEnum('platform').notNull(),
    hidePreviews: boolean('hide_previews').notNull().default(false),
    lastSuccessAt: timestamp('last_success_at', { mode: 'date', withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { mode: 'date', withTimezone: true }),
  },
  (t) => ({
    tokenIdx: uniqueIndex('deviceTokenIdx').on(t.pushToken),
    userFk: foreignKey({ columns: [t.userId], foreignColumns: [users.id] }),
  }),
);

// ---- ordering (server-side only; per-member encrypted OAuth) ----

export const swiggyTokens = pgTable(
  'swiggy_tokens',
  {
    userId: uuid('user_id').primaryKey(),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userFk: foreignKey({ columns: [t.userId], foreignColumns: [users.id] }),
  }),
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: varchar('key', { length: 128 }).primaryKey(),
    membershipId: uuid('membership_id').notNull(),
    householdId: uuid('household_id').notNull(),
    status: idempotencyStatusEnum('status').notNull().default('in_flight'),
    result: jsonb('result').$type<unknown>(),
    createdAt: now(),
  },
  (t) => ({
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
  }),
);

/** Append-only checkout audit (issue 07, AC#19). */
export const checkoutAudit = pgTable(
  'checkout_audit',
  {
    id: id(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    membershipId: uuid('membership_id').notNull(),
    householdId: uuid('household_id').notNull(),
    cartTotalCents: bigint('cart_total_cents', { mode: 'number' }),
    paymentMethod: varchar('payment_method', { length: 64 }),
    result: varchar('result', { length: 64 }).notNull(),
    verifiedViaGetOrders: boolean('verified_via_get_orders').notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    householdIdx: index('checkoutAuditHouseholdIdx').on(t.householdId),
    householdFk: foreignKey({ columns: [t.householdId], foreignColumns: [households.id] }),
    cartTotalCentsCheck: check(
      'checkout_audit_cart_total_cents_nonneg',
      sql`${t.cartTotalCents} >= 0`,
    ),
  }),
);
