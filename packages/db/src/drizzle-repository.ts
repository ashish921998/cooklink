import { randomUUID } from 'node:crypto';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import {
  brandId,
  type ActionSuggestion,
  type ChatMessage,
  type ChatMessageId,
  type DeviceId,
  type DeviceRegistration,
  type GroceryOrder,
  type GroceryOrderId,
  type GroceryRequest,
  type GroceryRequestId,
  type Household,
  type HouseholdId,
  type HouseholdMemberState,
  type IdempotencyKeyRecord,
  type CheckoutAuditRecord,
  type Membership,
  type MembershipId,
  type PantryLedgerEntry,
  type PlannedMeal,
  type PlannedMealId,
  type ProductMatch,
  type Recipe,
  type RecipeId,
  type Repository,
  type SuggestedCartItem,
  type SystemEvent,
  type TimelineItem,
  type User,
  type UserId,
  type VoiceTranscript,
  type SystemEventType,
} from '@cooklink/domain';
import type { Database } from './client.js';
import * as s from './schema.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type DbLike = Database | Tx;

/**
 * The Postgres/Drizzle implementation of the domain `Repository` port.
 * Maps rows onto branded domain ids on read; the application server's route
 * modules use this for product matches, orders, and checkout audit rows.
 */
export class DrizzleRepository implements Repository {
  constructor(private readonly db: Database) {}

  async findActiveMembership(userId: UserId, householdId: HouseholdId) {
    const [row] = await this.db
      .select({ membership: s.memberships, household: s.households })
      .from(s.memberships)
      .innerJoin(s.households, eq(s.households.id, s.memberships.householdId))
      .where(
        and(
          eq(s.memberships.userId, userId),
          eq(s.memberships.householdId, householdId),
          eq(s.memberships.status, 'active'),
          isNull(s.households.closedAt),
        ),
      )
      .limit(1);
    return row
      ? { membership: membership(row.membership), household: household(row.household) }
      : null;
  }

  async getUserByClerkId(clerkUserId: string) {
    const [row] = await this.db
      .select()
      .from(s.users)
      .where(eq(s.users.clerkUserId, clerkUserId))
      .limit(1);
    return row ? user(row) : null;
  }

  async createUser(input: Omit<User, 'createdAt'> & { createdAt?: string }) {
    await this.db.insert(s.users).values({
      id: input.id,
      clerkUserId: input.clerkUserId,
      phone: input.phone,
      displayName: input.displayName,
      createdAt: input.createdAt ? new Date(input.createdAt) : undefined,
    });
    const created = await this.getUserByClerkId(input.clerkUserId);
    if (!created) throw new Error('create_user_failed');
    return created;
  }

  async getHousehold(householdId: HouseholdId) {
    const [row] = await this.db
      .select()
      .from(s.households)
      .where(eq(s.households.id, householdId))
      .limit(1);
    return row ? household(row) : null;
  }

  async listHouseholdsForUser(userId: UserId) {
    const rows = await this.db
      .select({ household: s.households, membership: s.memberships })
      .from(s.memberships)
      .innerJoin(s.households, eq(s.households.id, s.memberships.householdId))
      .where(
        and(
          eq(s.memberships.userId, userId),
          eq(s.memberships.status, 'active'),
          isNull(s.households.closedAt),
        ),
      );
    return rows.map((row) => ({
      household: household(row.household),
      membership: membership(row.membership),
    }));
  }

  async createHousehold(input: Omit<Household, 'id' | 'createdAt' | 'closedAt'>, ownerId: UserId) {
    return this.db.transaction(async (tx) => {
      const householdId = brandId<'HouseholdId'>(randomUUID());
      const membershipId = brandId<'MembershipId'>(randomUUID());
      await tx.insert(s.households).values({ id: householdId, ...input });
      await tx.insert(s.memberships).values({
        id: membershipId,
        userId: ownerId,
        householdId,
        role: 'owner',
        status: 'active',
        notificationDefault: 'all',
      });
      return {
        household: await mustHousehold(tx, householdId),
        ownerMembership: await mustMembership(tx, membershipId),
      };
    });
  }

  async getMembership(membershipId: MembershipId) {
    const [row] = await this.db
      .select()
      .from(s.memberships)
      .where(eq(s.memberships.id, membershipId))
      .limit(1);
    return row ? membership(row) : null;
  }

  async listMembers(householdId: HouseholdId) {
    const rows = await this.db
      .select()
      .from(s.memberships)
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.status, 'active')));
    return rows.map(membership);
  }

  async addMembership(householdId: HouseholdId, userId: UserId, role: Membership['role']) {
    const membershipId = brandId<'MembershipId'>(randomUUID());
    await this.db.insert(s.memberships).values({
      id: membershipId,
      userId,
      householdId,
      role,
      status: 'active',
      notificationDefault: role === 'cook' ? 'important' : 'all',
    });
    return mustMembership(this.db, membershipId);
  }

  async removeMembership(membershipId: MembershipId) {
    await this.db
      .update(s.memberships)
      .set({ status: 'removed', removedAt: new Date() })
      .where(eq(s.memberships.id, membershipId));
  }

  async countActiveCooks(householdId: HouseholdId) {
    const rows = await this.listMembers(householdId);
    return rows.filter((row) => row.role === 'cook').length;
  }

  async countActiveHouseholdsForCook(userId: UserId) {
    const rows = await this.db
      .select()
      .from(s.memberships)
      .where(
        and(
          eq(s.memberships.userId, userId),
          eq(s.memberships.role, 'cook'),
          eq(s.memberships.status, 'active'),
        ),
      );
    return rows.length;
  }

  async getPlannedMeal(mealId: PlannedMealId) {
    const [row] = await this.db
      .select()
      .from(s.plannedMeals)
      .where(eq(s.plannedMeals.id, mealId))
      .limit(1);
    return row ? plannedMeal(row) : null;
  }

  async listMealsForRange(householdId: HouseholdId, startDate: string, endDate: string) {
    const rows = await this.db
      .select()
      .from(s.plannedMeals)
      .where(
        and(
          eq(s.plannedMeals.householdId, householdId),
          gte(s.plannedMeals.date, startDate),
          lte(s.plannedMeals.date, endDate),
        ),
      );
    return rows
      .map(plannedMeal)
      .sort((a, b) => a.date.localeCompare(b.date) || a.mealType.localeCompare(b.mealType));
  }

  async listMealsForDay(householdId: HouseholdId, date: string) {
    const rows = await this.db
      .select()
      .from(s.plannedMeals)
      .where(and(eq(s.plannedMeals.householdId, householdId), eq(s.plannedMeals.date, date)));
    return rows.map(plannedMeal).sort((a, b) => a.mealType.localeCompare(b.mealType));
  }

  async upsertPlannedMeal(
    householdId: HouseholdId,
    meal: Omit<PlannedMeal, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'householdId'>,
    actor: MembershipId,
  ) {
    const [existing] = await this.db
      .select()
      .from(s.plannedMeals)
      .where(
        and(
          eq(s.plannedMeals.householdId, householdId),
          eq(s.plannedMeals.date, meal.date),
          eq(s.plannedMeals.mealType, meal.mealType),
        ),
      )
      .limit(1);
    if (existing)
      return this.updatePlannedMeal(
        householdId,
        brandId<'PlannedMealId'>(existing.id),
        existing.version,
        meal,
        actor,
      );
    const mealId = brandId<'PlannedMealId'>(randomUUID());
    await this.db
      .insert(s.plannedMeals)
      .values({ id: mealId, householdId, ...meal, version: 1, updatedBy: actor });
    const created = await this.getPlannedMeal(mealId);
    if (!created) throw new Error('create_meal_failed');
    return created;
  }

  async updatePlannedMeal(
    householdId: HouseholdId,
    mealId: PlannedMealId,
    expectedVersion: number,
    patch: Partial<PlannedMeal>,
    actor: MembershipId,
  ) {
    const current = await this.getPlannedMeal(mealId);
    if (!current || current.householdId !== householdId) throw new Error('not_found');
    if (current.version !== expectedVersion)
      throw Object.assign(new Error('conflict'), { code: 'conflict', current });
    await this.db
      .update(s.plannedMeals)
      .set({
        ...mealPatch(patch),
        version: current.version + 1,
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(and(eq(s.plannedMeals.id, mealId), eq(s.plannedMeals.householdId, householdId)));
    const updated = await this.getPlannedMeal(mealId);
    if (!updated) throw new Error('update_meal_failed');
    return updated;
  }

  async replaceMealPlanRange(
    householdId: HouseholdId,
    startDate: string,
    meals: Omit<PlannedMeal, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'householdId'>[],
    actor: MembershipId,
  ) {
    return this.db.transaction(async (tx) => {
      const dates = new Set(meals.map((meal) => meal.date));
      for (const date of dates) {
        if (date >= startDate)
          await tx
            .delete(s.plannedMeals)
            .where(and(eq(s.plannedMeals.householdId, householdId), eq(s.plannedMeals.date, date)));
      }
      if (meals.length > 0) {
        await tx.insert(s.plannedMeals).values(
          meals.map((meal) => ({
            id: randomUUID(),
            householdId,
            ...meal,
            version: 1,
            updatedBy: actor,
          })),
        );
      }
      return (
        await tx.select().from(s.plannedMeals).where(eq(s.plannedMeals.householdId, householdId))
      ).map(plannedMeal);
    });
  }

  async getRecipe(recipeId: RecipeId) {
    const [row] = await this.db.select().from(s.recipes).where(eq(s.recipes.id, recipeId)).limit(1);
    return row ? recipe(row) : null;
  }

  async searchRecipesForDiet(query: string, householdDietStyle: Household['dietStyle']) {
    const rows = await this.db
      .select()
      .from(s.recipes)
      .where(
        or(eq(s.recipes.dietStyle, householdDietStyle), eq(s.recipes.dietStyle, 'vegetarian')),
      );
    const q = query.toLowerCase();
    return rows
      .map(recipe)
      .filter((row) => row.name.toLowerCase().includes(q) || (row.nameHi?.includes(q) ?? false));
  }

  async getGroceryRequest(requestId: GroceryRequestId) {
    const [row] = await this.db
      .select()
      .from(s.groceryRequests)
      .where(eq(s.groceryRequests.id, requestId))
      .limit(1);
    return row ? groceryRequest(row) : null;
  }

  async listGroceryRequests(householdId: HouseholdId, status?: GroceryRequest['status']) {
    const rows = await this.db
      .select()
      .from(s.groceryRequests)
      .where(
        status
          ? and(
              eq(s.groceryRequests.householdId, householdId),
              eq(s.groceryRequests.status, status),
            )
          : eq(s.groceryRequests.householdId, householdId),
      );
    return rows.map(groceryRequest).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createGroceryRequest(
    householdId: HouseholdId,
    input: { itemText: string; quantityText: string | null },
    createdById: MembershipId,
  ) {
    return this.db.transaction(async (tx) => {
      const requestId = brandId<'GroceryRequestId'>(randomUUID());
      await tx
        .insert(s.groceryRequests)
        .values({ id: requestId, householdId, ...input, createdById });
      const event = await insertSystemEvent(tx, householdId, {
        type: 'grocery_request.created',
        actorId: createdById,
        entityType: 'grocery_request',
        entityId: requestId,
        payload: { item: input.itemText, quantity: input.quantityText, status: 'pending' },
      });
      const request = await mustGroceryRequest(tx, requestId);
      return { request, event };
    });
  }

  async updateGroceryRequest(
    householdId: HouseholdId,
    requestId: GroceryRequestId,
    expectedVersion: number,
    patch: Partial<GroceryRequest>,
    actor: MembershipId,
  ) {
    return this.db.transaction(async (tx) => {
      const current = await getGroceryRequest(tx, requestId);
      if (!current || current.householdId !== householdId) throw new Error('not_found');
      if (current.version !== expectedVersion)
        throw Object.assign(new Error('conflict'), { code: 'conflict', current });
      const nextStatus = patch.status ?? current.status;
      await tx
        .update(s.groceryRequests)
        .set({
          itemText: patch.itemText,
          quantityText: patch.quantityText,
          status: patch.status,
          resolvedById: patch.status && patch.status !== 'pending' ? actor : current.resolvedById,
          resolvedAt:
            patch.status && patch.status !== 'pending'
              ? new Date()
              : current.resolvedAt
                ? new Date(current.resolvedAt)
                : null,
          version: current.version + 1,
        })
        .where(
          and(eq(s.groceryRequests.id, requestId), eq(s.groceryRequests.householdId, householdId)),
        );
      const event = await insertSystemEvent(tx, householdId, {
        type: groceryRequestEventType(nextStatus),
        actorId: actor,
        entityType: 'grocery_request',
        entityId: requestId,
        payload: {
          item: patch.itemText ?? current.itemText,
          quantity: patch.quantityText ?? current.quantityText,
          status: nextStatus,
        },
      });
      const request = await mustGroceryRequest(tx, requestId);
      return { request, event };
    });
  }

  async getSuggestedCart(householdId: HouseholdId) {
    const rows = await this.db
      .select()
      .from(s.suggestedCartItems)
      .where(eq(s.suggestedCartItems.householdId, householdId));
    return rows.map(suggestedCartItem).sort((a, b) => a.needDay.localeCompare(b.needDay));
  }

  async replaceSuggestedCart(householdId: HouseholdId, items: SuggestedCartItem[]) {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(s.suggestedCartItems)
        .where(eq(s.suggestedCartItems.householdId, householdId));
      if (items.length > 0)
        await tx
          .insert(s.suggestedCartItems)
          .values(items.map((item) => ({ ...item, householdId })));
    });
    return this.getSuggestedCart(householdId);
  }

  async setCartItemState(
    householdId: HouseholdId,
    itemId: string,
    state: SuggestedCartItem['memberState'],
    reason: SuggestedCartItem['removalReason'] | null,
  ) {
    await this.db
      .update(s.suggestedCartItems)
      .set({ memberState: state, removalReason: reason })
      .where(
        and(eq(s.suggestedCartItems.householdId, householdId), eq(s.suggestedCartItems.id, itemId)),
      );
  }

  async appendPantryLedger(
    householdId: HouseholdId,
    entry: Omit<PantryLedgerEntry, 'id' | 'householdId'>,
  ) {
    await this.db
      .insert(s.pantryLedger)
      .values({ id: randomUUID(), householdId, ...entry, at: new Date(entry.at) });
  }

  async replaceConsumptionLedger(
    householdId: HouseholdId,
    entries: Omit<PantryLedgerEntry, 'id' | 'householdId'>[],
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(s.pantryLedger)
        .where(
          and(
            eq(s.pantryLedger.householdId, householdId),
            eq(s.pantryLedger.source, 'consumption'),
          ),
        );
      if (entries.length > 0) {
        await tx.insert(s.pantryLedger).values(
          entries.map((entry) => ({
            id: randomUUID(),
            householdId,
            ...entry,
            at: new Date(entry.at),
          })),
        );
      }
    });
  }

  async listPantryLedger(householdId: HouseholdId, ingredientKey: string) {
    const rows = await this.db
      .select()
      .from(s.pantryLedger)
      .where(
        and(
          eq(s.pantryLedger.householdId, householdId),
          eq(s.pantryLedger.ingredientKey, ingredientKey),
        ),
      );
    return rows.map(pantryLedgerEntry).sort((a, b) => a.at.localeCompare(b.at));
  }

  async getChatTimeline(householdId: HouseholdId, afterId: ChatMessageId | null, limit: number) {
    const messageRows = await this.db
      .select()
      .from(s.chatMessages)
      .where(eq(s.chatMessages.householdId, householdId));
    const transcriptRows = await this.db.select().from(s.voiceTranscripts);
    const transcripts = new Map(transcriptRows.map((row) => [row.messageId, voiceTranscript(row)]));
    const messages = messageRows.map((row) => {
      const message = chatMessage(row);
      return {
        kind: 'message' as const,
        message,
        transcript: transcripts.get(message.id as string) ?? null,
      };
    });
    const events = (
      await this.db.select().from(s.systemEvents).where(eq(s.systemEvents.householdId, householdId))
    ).map((row) => ({ kind: 'event' as const, event: systemEvent(row) }));
    const merged: TimelineItem[] = [...messages, ...events].sort((a, b) =>
      timeOf(a).localeCompare(timeOf(b)),
    );
    if (afterId) {
      const index = merged.findIndex((item) => idOf(item) === afterId);
      return index >= 0 ? merged.slice(index + 1, index + 1 + limit) : [];
    }
    const start = Math.max(0, merged.length - limit);
    return merged.slice(start, start + limit);
  }

  async getMessage(messageId: ChatMessageId) {
    const [row] = await this.db
      .select()
      .from(s.chatMessages)
      .where(eq(s.chatMessages.id, messageId))
      .limit(1);
    return row ? chatMessage(row) : null;
  }

  async getTranscript(messageId: ChatMessageId) {
    const [row] = await this.db
      .select()
      .from(s.voiceTranscripts)
      .where(eq(s.voiceTranscripts.messageId, messageId))
      .limit(1);
    return row ? voiceTranscript(row) : null;
  }

  async createMessage(
    householdId: HouseholdId,
    input: {
      senderId: MembershipId;
      kind: ChatMessage['kind'];
      body: string | null;
      caption: string | null;
      mediaRef: string | null;
      clientCreatedAt: string;
    },
  ) {
    const messageId = brandId<'ChatMessageId'>(randomUUID());
    await this.db.insert(s.chatMessages).values({
      id: messageId,
      householdId,
      ...input,
      clientCreatedAt: new Date(input.clientCreatedAt),
    });
    const created = await this.getMessage(messageId);
    if (!created) throw new Error('create_message_failed');
    return created;
  }

  async editMessage(
    householdId: HouseholdId,
    messageId: ChatMessageId,
    senderId: MembershipId,
    patch: { body?: string | null; caption?: string | null },
  ) {
    await this.db
      .update(s.chatMessages)
      .set({ ...patch, editedAt: new Date() })
      .where(
        and(
          eq(s.chatMessages.householdId, householdId),
          eq(s.chatMessages.id, messageId),
          eq(s.chatMessages.senderId, senderId),
        ),
      );
    const updated = await this.getMessage(messageId);
    if (!updated || updated.householdId !== householdId || updated.senderId !== senderId)
      throw new Error('forbidden');
    return updated;
  }

  async deleteMessage(householdId: HouseholdId, messageId: ChatMessageId, senderId: MembershipId) {
    await this.db
      .update(s.chatMessages)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(s.chatMessages.householdId, householdId),
          eq(s.chatMessages.id, messageId),
          eq(s.chatMessages.senderId, senderId),
        ),
      );
    const updated = await this.getMessage(messageId);
    if (!updated || updated.householdId !== householdId || updated.senderId !== senderId)
      throw new Error('forbidden');
    return updated;
  }

  async setTranscript(messageId: ChatMessageId, transcript: VoiceTranscript) {
    await this.db
      .insert(s.voiceTranscripts)
      .values(transcript)
      .onConflictDoUpdate({ target: s.voiceTranscripts.messageId, set: transcript });
    const saved = await this.getTranscript(messageId);
    if (!saved) throw new Error('set_transcript_failed');
    return saved;
  }

  async appendSystemEvent(
    householdId: HouseholdId,
    event: Omit<SystemEvent, 'id' | 'createdAt' | 'householdId'>,
  ) {
    return insertSystemEvent(this.db, householdId, event);
  }

  async createSuggestion(
    householdId: HouseholdId,
    input: Omit<ActionSuggestion, 'id' | 'createdAt' | 'householdId' | 'status'>,
  ) {
    const suggestionId = brandId<'SuggestionId'>(randomUUID());
    await this.db.insert(s.actionSuggestions).values({
      id: suggestionId,
      householdId,
      ...input,
      status: 'pending',
      expiresAt: new Date(input.expiresAt),
    });
    const created = await this.getSuggestion(suggestionId);
    if (!created) throw new Error('create_suggestion_failed');
    return created;
  }

  async getSuggestion(suggestionId: string) {
    const [row] = await this.db
      .select()
      .from(s.actionSuggestions)
      .where(eq(s.actionSuggestions.id, suggestionId))
      .limit(1);
    return row ? actionSuggestion(row) : null;
  }

  async listPendingSuggestions(authorId: MembershipId) {
    const rows = await this.db
      .select()
      .from(s.actionSuggestions)
      .where(
        and(eq(s.actionSuggestions.authorId, authorId), eq(s.actionSuggestions.status, 'pending')),
      );
    return rows.map(actionSuggestion);
  }

  async updateSuggestionStatus(
    householdId: HouseholdId,
    suggestionId: string,
    status: ActionSuggestion['status'],
  ) {
    await this.db
      .update(s.actionSuggestions)
      .set({ status })
      .where(
        and(
          eq(s.actionSuggestions.householdId, householdId),
          eq(s.actionSuggestions.id, suggestionId),
        ),
      );
  }

  async getMemberState(userId: UserId, householdId: HouseholdId) {
    const [row] = await this.db
      .select()
      .from(s.householdMemberState)
      .where(
        and(
          eq(s.householdMemberState.userId, userId),
          eq(s.householdMemberState.householdId, householdId),
        ),
      )
      .limit(1);
    return row ? memberState(row) : null;
  }

  async markRead(userId: UserId, householdId: HouseholdId, upTo: ChatMessageId) {
    await this.db
      .insert(s.householdMemberState)
      .values({ userId, householdId, lastReadMessageId: upTo })
      .onConflictDoUpdate({
        target: [s.householdMemberState.userId, s.householdMemberState.householdId],
        set: { lastReadMessageId: upTo },
      });
  }
  async setNotificationOverride(
    userId: UserId,
    householdId: HouseholdId,
    override: HouseholdMemberState['notificationOverride'],
  ) {
    await this.db
      .insert(s.householdMemberState)
      .values({ userId, householdId, notificationOverride: override })
      .onConflictDoUpdate({
        target: [s.householdMemberState.userId, s.householdMemberState.householdId],
        set: { notificationOverride: override },
      });
    const [row] = await this.db
      .select()
      .from(s.householdMemberState)
      .where(
        and(
          eq(s.householdMemberState.userId, userId),
          eq(s.householdMemberState.householdId, householdId),
        ),
      )
      .limit(1);
    if (!row) throw new Error('set_notification_override_failed');
    return memberState(row);
  }

  async registerDevice(device: Omit<DeviceRegistration, 'id'>) {
    const deviceId = brandId<'DeviceId'>(randomUUID());
    await this.db
      .insert(s.deviceRegistrations)
      .values({
        id: deviceId,
        ...device,
        invalidatedAt: device.invalidatedAt ? new Date(device.invalidatedAt) : null,
      })
      .onConflictDoUpdate({
        target: s.deviceRegistrations.pushToken,
        set: {
          userId: device.userId,
          platform: device.platform,
          hidePreviews: device.hidePreviews,
          invalidatedAt: device.invalidatedAt ? new Date(device.invalidatedAt) : null,
        },
      });
    const [row] = await this.db
      .select()
      .from(s.deviceRegistrations)
      .where(eq(s.deviceRegistrations.pushToken, device.pushToken))
      .limit(1);
    if (!row) throw new Error('register_device_failed');
    return deviceRegistration(row);
  }

  async listDevices(userId: UserId) {
    const rows = await this.db
      .select()
      .from(s.deviceRegistrations)
      .where(eq(s.deviceRegistrations.userId, userId));
    return rows.map(deviceRegistration);
  }
  async invalidateDevice(deviceId: DeviceId) {
    await this.db
      .update(s.deviceRegistrations)
      .set({ invalidatedAt: new Date() })
      .where(eq(s.deviceRegistrations.id, deviceId));
  }

  async createOrder(
    householdId: HouseholdId,
    placedById: MembershipId,
    input: {
      providerOrderId: string | null;
      status: GroceryOrder['status'];
      totalCents: number | null;
    },
  ) {
    const orderId = brandId<'GroceryOrderId'>(randomUUID());
    await this.db
      .insert(s.groceryOrders)
      .values({ id: orderId, householdId, placedById, ...input });
    const created = await this.getOrder(orderId);
    if (!created) throw new Error('create_order_failed');
    return created;
  }

  async getOrder(orderId: GroceryOrderId | string) {
    const [row] = await this.db
      .select()
      .from(s.groceryOrders)
      .where(eq(s.groceryOrders.id, orderId))
      .limit(1);
    return row ? groceryOrder(row) : null;
  }

  async listOrders(householdId: HouseholdId) {
    const rows = await this.db
      .select()
      .from(s.groceryOrders)
      .where(eq(s.groceryOrders.householdId, householdId));
    return rows.map(groceryOrder);
  }

  async updateOrderStatus(
    householdId: HouseholdId,
    orderId: GroceryOrderId,
    status: GroceryOrder['status'],
  ) {
    await this.db
      .update(s.groceryOrders)
      .set({ status })
      .where(and(eq(s.groceryOrders.id, orderId), eq(s.groceryOrders.householdId, householdId)));
  }

  // ---- checkout attempts + audit (issue 11, AC#5) ----
  async getIdempotencyKey(key: string) {
    const [row] = await this.db
      .select()
      .from(s.idempotencyKeys)
      .where(eq(s.idempotencyKeys.key, key))
      .limit(1);
    return row ? idempotencyKey(row) : null;
  }

  async beginIdempotencyKey(input: {
    key: string;
    membershipId: MembershipId;
    householdId: HouseholdId;
  }) {
    // The unique `key` constraint prevents a duplicate insert; a concurrent
    // second attempt observes the existing row instead of placing again
    // (issue 11, AC#5 — unique checkout attempt).
    try {
      await this.db.insert(s.idempotencyKeys).values({
        key: input.key,
        membershipId: input.membershipId,
        householdId: input.householdId,
        status: 'in_flight',
        result: null,
      });
    } catch {
      const existing = await this.getIdempotencyKey(input.key);
      if (existing) return existing;
      throw new Error('begin_idempotency_key_failed');
    }
    const created = await this.getIdempotencyKey(input.key);
    if (!created) throw new Error('begin_idempotency_key_failed');
    return created;
  }

  async completeIdempotencyKey(key: string, status: 'succeeded' | 'failed', result: unknown) {
    await this.db
      .update(s.idempotencyKeys)
      .set({ status, result })
      .where(eq(s.idempotencyKeys.key, key));
  }

  async appendCheckoutAudit(input: Omit<CheckoutAuditRecord, 'id' | 'createdAt'>) {
    const auditId = randomUUID();
    await this.db.insert(s.checkoutAudit).values({
      id: auditId,
      idempotencyKey: input.idempotencyKey,
      membershipId: input.membershipId,
      householdId: input.householdId,
      cartTotalCents: input.cartTotalCents,
      paymentMethod: input.paymentMethod,
      result: input.result,
      verifiedViaGetOrders: input.verifiedViaGetOrders,
    });
    const [row] = await this.db
      .select()
      .from(s.checkoutAudit)
      .where(eq(s.checkoutAudit.id, auditId))
      .limit(1);
    if (!row) throw new Error('append_checkout_audit_failed');
    return checkoutAudit(row);
  }

  async listCheckoutAudit(householdId: HouseholdId) {
    const rows = await this.db
      .select()
      .from(s.checkoutAudit)
      .where(eq(s.checkoutAudit.householdId, householdId));
    return rows.map(checkoutAudit).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- product matches (issue 10) ----
  async getProductMatches(householdId: HouseholdId) {
    const rows = await this.db
      .select()
      .from(s.productMatches)
      .where(eq(s.productMatches.householdId, householdId));
    return rows.map(productMatch);
  }

  async upsertProductMatch(match: ProductMatch) {
    await this.db
      .insert(s.productMatches)
      .values({
        id: match.id,
        householdId: match.householdId,
        cartItemId: match.cartItemId,
        productId: match.productId,
        addressId: match.addressId,
        quantity: match.quantity,
        product: match.product,
        selectedById: match.selectedById,
        selectedAt: new Date(match.selectedAt),
      })
      .onConflictDoUpdate({
        target: [s.productMatches.householdId, s.productMatches.cartItemId],
        set: {
          productId: match.productId,
          addressId: match.addressId,
          quantity: match.quantity,
          product: match.product,
          selectedById: match.selectedById,
          selectedAt: new Date(match.selectedAt),
        },
      });
    return match;
  }

  async clearProductMatch(householdId: HouseholdId, cartItemId: string) {
    await this.db
      .delete(s.productMatches)
      .where(
        and(
          eq(s.productMatches.householdId, householdId),
          eq(s.productMatches.cartItemId, cartItemId),
        ),
      );
  }

  async clearProductMatches(householdId: HouseholdId) {
    await this.db.delete(s.productMatches).where(eq(s.productMatches.householdId, householdId));
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function mustHousehold(db: DbLike, householdId: HouseholdId) {
  const [row] = await db
    .select()
    .from(s.households)
    .where(eq(s.households.id, householdId))
    .limit(1);
  if (!row) throw new Error('household_not_found');
  return household(row);
}

async function mustMembership(db: DbLike, membershipId: MembershipId) {
  const [row] = await db
    .select()
    .from(s.memberships)
    .where(eq(s.memberships.id, membershipId))
    .limit(1);
  if (!row) throw new Error('membership_not_found');
  return membership(row);
}

async function getGroceryRequest(db: DbLike, requestId: GroceryRequestId) {
  const [row] = await db
    .select()
    .from(s.groceryRequests)
    .where(eq(s.groceryRequests.id, requestId))
    .limit(1);
  return row ? groceryRequest(row) : null;
}

async function mustGroceryRequest(db: DbLike, requestId: GroceryRequestId) {
  const request = await getGroceryRequest(db, requestId);
  if (!request) throw new Error('grocery_request_not_found');
  return request;
}

async function insertSystemEvent(
  db: DbLike,
  householdId: HouseholdId,
  event: Omit<SystemEvent, 'id' | 'createdAt' | 'householdId'>,
) {
  const eventId = brandId<'SystemEventId'>(randomUUID());
  await db.insert(s.systemEvents).values({ id: eventId, householdId, ...event });
  const [row] = await db
    .select()
    .from(s.systemEvents)
    .where(eq(s.systemEvents.id, eventId))
    .limit(1);
  if (!row) throw new Error('system_event_not_found');
  return systemEvent(row);
}

function user(row: typeof s.users.$inferSelect): User {
  return { ...row, id: brandId<'UserId'>(row.id), createdAt: iso(row.createdAt) };
}

function household(row: typeof s.households.$inferSelect): Household {
  return {
    ...row,
    id: brandId<'HouseholdId'>(row.id),
    createdAt: iso(row.createdAt),
    closedAt: row.closedAt ? iso(row.closedAt) : null,
  };
}

function membership(row: typeof s.memberships.$inferSelect): Membership {
  return {
    ...row,
    id: brandId<'MembershipId'>(row.id),
    userId: brandId<'UserId'>(row.userId),
    householdId: brandId<'HouseholdId'>(row.householdId),
    joinedAt: iso(row.joinedAt),
    removedAt: row.removedAt ? iso(row.removedAt) : null,
  };
}

function plannedMeal(row: typeof s.plannedMeals.$inferSelect): PlannedMeal {
  return {
    ...row,
    id: brandId<'PlannedMealId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    recipeId: row.recipeId ? brandId<'RecipeId'>(row.recipeId) : null,
    updatedBy: row.updatedBy ? brandId<'MembershipId'>(row.updatedBy) : null,
    updatedAt: iso(row.updatedAt),
  };
}

function recipe(row: typeof s.recipes.$inferSelect): Recipe {
  return {
    ...row,
    id: brandId<'RecipeId'>(row.id),
    ingredients: row.ingredients as Recipe['ingredients'],
    mealTypes: row.mealTypes as Recipe['mealTypes'],
  };
}

function groceryRequest(row: typeof s.groceryRequests.$inferSelect): GroceryRequest {
  return {
    ...row,
    id: brandId<'GroceryRequestId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    createdById: brandId<'MembershipId'>(row.createdById),
    createdAt: iso(row.createdAt),
    resolvedById: row.resolvedById ? brandId<'MembershipId'>(row.resolvedById) : null,
    resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
  };
}

function suggestedCartItem(row: typeof s.suggestedCartItems.$inferSelect): SuggestedCartItem {
  return {
    ...row,
    householdId: brandId<'HouseholdId'>(row.householdId),
    groceryRequestId: row.groceryRequestId
      ? brandId<'GroceryRequestId'>(row.groceryRequestId)
      : null,
    affectedMeals: row.affectedMeals as SuggestedCartItem['affectedMeals'],
  };
}

function pantryLedgerEntry(row: typeof s.pantryLedger.$inferSelect): PantryLedgerEntry {
  return { ...row, householdId: brandId<'HouseholdId'>(row.householdId), at: iso(row.at) };
}

function chatMessage(row: typeof s.chatMessages.$inferSelect): ChatMessage {
  return {
    ...row,
    id: brandId<'ChatMessageId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    senderId: brandId<'MembershipId'>(row.senderId),
    clientCreatedAt: iso(row.clientCreatedAt),
    serverCreatedAt: iso(row.serverCreatedAt),
    editedAt: row.editedAt ? iso(row.editedAt) : null,
    deletedAt: row.deletedAt ? iso(row.deletedAt) : null,
  };
}

function voiceTranscript(row: typeof s.voiceTranscripts.$inferSelect): VoiceTranscript {
  return { ...row, messageId: brandId<'ChatMessageId'>(row.messageId) };
}

function systemEvent(row: typeof s.systemEvents.$inferSelect): SystemEvent {
  return {
    ...row,
    id: brandId<'SystemEventId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    type: row.type as SystemEventType,
    actorId: row.actorId ? brandId<'MembershipId'>(row.actorId) : null,
    createdAt: iso(row.createdAt),
  };
}

function actionSuggestion(row: typeof s.actionSuggestions.$inferSelect): ActionSuggestion {
  return {
    ...row,
    id: brandId<'SuggestionId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    authorId: brandId<'MembershipId'>(row.authorId),
    sourceMessageId: row.sourceMessageId ? brandId<'ChatMessageId'>(row.sourceMessageId) : null,
    intent: row.intent as ActionSuggestion['intent'],
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

function memberState(row: typeof s.householdMemberState.$inferSelect): HouseholdMemberState {
  return {
    ...row,
    userId: brandId<'UserId'>(row.userId),
    householdId: brandId<'HouseholdId'>(row.householdId),
    lastReadMessageId: row.lastReadMessageId
      ? brandId<'ChatMessageId'>(row.lastReadMessageId)
      : null,
  };
}

function deviceRegistration(row: typeof s.deviceRegistrations.$inferSelect): DeviceRegistration {
  return {
    ...row,
    id: brandId<'DeviceId'>(row.id),
    userId: brandId<'UserId'>(row.userId),
    invalidatedAt: row.invalidatedAt ? iso(row.invalidatedAt) : null,
  };
}

function groceryOrder(row: typeof s.groceryOrders.$inferSelect): GroceryOrder {
  return {
    ...row,
    id: brandId<'GroceryOrderId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    placedById: brandId<'MembershipId'>(row.placedById),
    createdAt: iso(row.createdAt),
  };
}

function productMatch(row: typeof s.productMatches.$inferSelect): ProductMatch {
  return {
    id: row.id,
    householdId: brandId<'HouseholdId'>(row.householdId),
    cartItemId: row.cartItemId,
    productId: row.productId,
    addressId: row.addressId,
    quantity: row.quantity,
    product: row.product as ProductMatch['product'],
    selectedById: brandId<'MembershipId'>(row.selectedById),
    selectedAt: iso(row.selectedAt),
  };
}

function idempotencyKey(row: typeof s.idempotencyKeys.$inferSelect): IdempotencyKeyRecord {
  return {
    key: row.key,
    membershipId: brandId<'MembershipId'>(row.membershipId),
    householdId: brandId<'HouseholdId'>(row.householdId),
    status: row.status as IdempotencyKeyRecord['status'],
    result: row.result,
    createdAt: iso(row.createdAt),
  };
}

function checkoutAudit(row: typeof s.checkoutAudit.$inferSelect): CheckoutAuditRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    membershipId: brandId<'MembershipId'>(row.membershipId),
    householdId: brandId<'HouseholdId'>(row.householdId),
    cartTotalCents: row.cartTotalCents ?? null,
    paymentMethod: row.paymentMethod ?? null,
    result: row.result,
    verifiedViaGetOrders: row.verifiedViaGetOrders,
    createdAt: iso(row.createdAt),
  };
}

function mealPatch(patch: Partial<PlannedMeal>): Partial<typeof s.plannedMeals.$inferInsert> {
  return {
    date: patch.date,
    mealType: patch.mealType,
    recipeId: patch.recipeId,
    name: patch.name,
    servings: patch.servings,
    servingsOverridden: patch.servingsOverridden,
    isSpecial: patch.isSpecial,
  };
}

function groceryRequestEventType(status: GroceryRequest['status']): SystemEvent['type'] {
  if (status === 'approved') return 'grocery_request.approved';
  if (status === 'rejected') return 'grocery_request.rejected';
  if (status === 'cancelled') return 'grocery_request.cancelled';
  if (status === 'in_order') return 'grocery_request.in_order';
  if (status === 'fulfilled') return 'grocery_request.fulfilled';
  return 'grocery_request.updated';
}

function timeOf(item: TimelineItem): string {
  return item.kind === 'message' ? item.message.serverCreatedAt : item.event.createdAt;
}

function idOf(item: TimelineItem): string {
  return item.kind === 'message' ? item.message.id : item.event.id;
}
