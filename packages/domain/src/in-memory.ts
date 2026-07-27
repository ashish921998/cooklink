import { id } from './ids.js';
import type {
  ChatMessageId,
  DeviceId,
  GroceryOrderId,
  GroceryRequestId,
  HouseholdId,
  MembershipId,
  PlannedMealId,
  RecipeId,
  UserId,
} from './ids.js';
import type { Repository } from './repository.js';
import type {
  ActionSuggestion,
  ChatMessage,
  DeviceRegistration,
  GroceryOrder,
  Household,
  HouseholdMemberState,
  IdempotencyKeyRecord,
  CheckoutAuditRecord,
  Membership,
  NotificationLevel,
  PantryLedgerEntry,
  PlannedMeal,
  Recipe,
  SuggestedCartItem,
  SystemEvent,
  TimelineItem,
  User,
  VoiceTranscript,
  GroceryRequest,
} from './types.js';
import type { ProductMatch } from './provider.js';

/**
 * A fully in-memory {@link Repository} used by the test suite (and by local
 * mobile development). It implements the exact same household-scoped contract
 * as the Drizzle backend, so the authorization isolation tests prove the
 * domain logic rather than any particular database.
 */
export class InMemoryRepository implements Repository {
  readonly users = new Map<string, User>();
  readonly households = new Map<string, Household>();
  readonly memberships = new Map<string, Membership>();
  readonly meals = new Map<string, PlannedMeal>();
  readonly recipes = new Map<string, Recipe>();
  readonly requests = new Map<string, GroceryRequest>();
  readonly cartItems = new Map<string, SuggestedCartItem>();
  readonly ledger: PantryLedgerEntry[] = [];
  readonly messages = new Map<string, ChatMessage>();
  readonly transcripts = new Map<string, VoiceTranscript>();
  readonly events: SystemEvent[] = [];
  readonly suggestions = new Map<string, ActionSuggestion>();
  readonly memberState = new Map<string, HouseholdMemberState>();
  readonly devices = new Map<string, DeviceRegistration>();
  readonly orders = new Map<string, GroceryOrder>();
  readonly productMatches = new Map<string, ProductMatch>();
  readonly idempotencyKeys = new Map<string, IdempotencyKeyRecord>();
  readonly checkoutAudit: CheckoutAuditRecord[] = [];

  private now(): string {
    return new Date().toISOString();
  }

  async findActiveMembership(
    userId: UserId,
    householdId: HouseholdId,
  ): Promise<{ membership: Membership; household: Household } | null> {
    for (const m of this.memberships.values()) {
      if (m.userId === userId && m.householdId === householdId && m.status === 'active') {
        const household = this.households.get(householdId as string);
        if (household) return { membership: m, household };
      }
    }
    return null;
  }

  async getUserByClerkId(clerkUserId: string): Promise<User | null> {
    for (const u of this.users.values()) if (u.clerkUserId === clerkUserId) return u;
    return null;
  }
  async createUser(user: Omit<User, 'createdAt'> & { createdAt?: string }): Promise<User> {
    const full: User = { ...user, createdAt: user.createdAt ?? this.now() };
    this.users.set(full.id as string, full);
    return full;
  }
  async getHousehold(householdId: HouseholdId): Promise<Household | null> {
    return this.households.get(householdId as string) ?? null;
  }
  async listHouseholdsForUser(
    userId: UserId,
  ): Promise<{ household: Household; membership: Membership }[]> {
    const out: { household: Household; membership: Membership }[] = [];
    for (const m of this.memberships.values()) {
      if (m.userId === userId && m.status === 'active') {
        const h = this.households.get(m.householdId as string);
        if (h && !h.closedAt) out.push({ household: h, membership: m });
      }
    }
    return out;
  }
  async createHousehold(
    household: Omit<Household, 'id' | 'createdAt' | 'closedAt'>,
    ownerId: UserId,
  ): Promise<{ household: Household; ownerMembership: Membership }> {
    const hid = id<'HouseholdId'>(crypto.randomUUID());
    const full: Household = {
      ...household,
      id: hid,
      createdAt: this.now(),
      closedAt: null,
    };
    this.households.set(hid as string, full);
    const membership: Membership = {
      id: id<'MembershipId'>(crypto.randomUUID()),
      userId: ownerId,
      householdId: hid,
      role: 'owner',
      status: 'active',
      notificationDefault: 'all',
      joinedAt: this.now(),
      removedAt: null,
    };
    this.memberships.set(membership.id as string, membership);
    return { household: full, ownerMembership: membership };
  }
  async getMembership(membershipId: MembershipId): Promise<Membership | null> {
    return this.memberships.get(membershipId as string) ?? null;
  }
  async listMembers(householdId: HouseholdId): Promise<Membership[]> {
    return [...this.memberships.values()].filter(
      (m) => m.householdId === householdId && m.status === 'active',
    );
  }
  async addMembership(
    householdId: HouseholdId,
    userId: UserId,
    role: Membership['role'],
  ): Promise<Membership> {
    const m: Membership = {
      id: id<'MembershipId'>(crypto.randomUUID()),
      userId,
      householdId,
      role,
      status: 'active',
      notificationDefault: role === 'cook' ? 'important' : 'all',
      joinedAt: this.now(),
      removedAt: null,
    };
    this.memberships.set(m.id as string, m);
    return m;
  }
  async removeMembership(membershipId: MembershipId): Promise<void> {
    const m = this.memberships.get(membershipId as string);
    if (m)
      this.memberships.set(membershipId as string, {
        ...m,
        status: 'removed',
        removedAt: this.now(),
      });
  }
  async countActiveCooks(householdId: HouseholdId): Promise<number> {
    return [...this.memberships.values()].filter(
      (m) => m.householdId === householdId && m.role === 'cook' && m.status === 'active',
    ).length;
  }
  async countActiveHouseholdsForCook(userId: UserId): Promise<number> {
    return [...this.memberships.values()].filter(
      (m) => m.userId === userId && m.role === 'cook' && m.status === 'active',
    ).length;
  }

  async getPlannedMeal(id: PlannedMealId): Promise<PlannedMeal | null> {
    return this.meals.get(id as string) ?? null;
  }
  async listMealsForRange(
    householdId: HouseholdId,
    startDate: string,
    endDate: string,
  ): Promise<PlannedMeal[]> {
    return [...this.meals.values()]
      .filter((m) => m.householdId === householdId && m.date >= startDate && m.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date) || a.mealType.localeCompare(b.mealType));
  }
  async listMealsForDay(householdId: HouseholdId, date: string): Promise<PlannedMeal[]> {
    return [...this.meals.values()]
      .filter((m) => m.householdId === householdId && m.date === date)
      .sort((a, b) => a.mealType.localeCompare(b.mealType));
  }
  async upsertPlannedMeal(
    householdId: HouseholdId,
    meal: Omit<PlannedMeal, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'householdId'>,
    actor: MembershipId,
  ): Promise<PlannedMeal> {
    const existing = [...this.meals.values()].find(
      (m) => m.householdId === householdId && m.date === meal.date && m.mealType === meal.mealType,
    );
    if (existing) {
      const updated: PlannedMeal = {
        ...existing,
        ...meal,
        householdId,
        version: existing.version + 1,
        updatedBy: actor,
        updatedAt: this.now(),
      };
      this.meals.set(existing.id as string, updated);
      return updated;
    }
    const full: PlannedMeal = {
      ...meal,
      id: id<'PlannedMealId'>(crypto.randomUUID()),
      householdId,
      version: 1,
      updatedBy: actor,
      updatedAt: this.now(),
    };
    this.meals.set(full.id as string, full);
    return full;
  }
  async updatePlannedMeal(
    householdId: HouseholdId,
    mealId: PlannedMealId,
    expectedVersion: number,
    patch: Partial<PlannedMeal>,
    actor: MembershipId,
  ): Promise<PlannedMeal> {
    const m = this.meals.get(mealId as string);
    if (!m || m.householdId !== householdId) throw new Error('not_found');
    if (m.version !== expectedVersion) {
      throw Object.assign(new Error('conflict'), { code: 'conflict', current: m });
    }
    const updated: PlannedMeal = {
      ...m,
      ...patch,
      version: m.version + 1,
      updatedBy: actor,
      updatedAt: this.now(),
    };
    this.meals.set(m.id as string, updated);
    return updated;
  }
  async replaceMealPlanRange(
    householdId: HouseholdId,
    _startDate: string,
    meals: Omit<PlannedMeal, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'householdId'>[],
    actor: MembershipId,
  ): Promise<PlannedMeal[]> {
    const out: PlannedMeal[] = [];
    for (const meal of meals) {
      const full: PlannedMeal = {
        ...meal,
        id: id<'PlannedMealId'>(crypto.randomUUID()),
        householdId,
        version: 1,
        updatedBy: actor,
        updatedAt: this.now(),
      };
      this.meals.set(full.id as string, full);
      out.push(full);
    }
    return out;
  }

  async getRecipe(recipeId: RecipeId): Promise<Recipe | null> {
    return this.recipes.get(recipeId as string) ?? null;
  }
  async searchRecipesForDiet(query: string, _diet: Household['dietStyle']): Promise<Recipe[]> {
    const q = query.toLowerCase();
    return [...this.recipes.values()].filter(
      (r) => r.name.toLowerCase().includes(q) || (r.nameHi?.includes(q) ?? false),
    );
  }

  async getGroceryRequest(id: GroceryRequestId): Promise<GroceryRequest | null> {
    return this.requests.get(id as string) ?? null;
  }
  async listGroceryRequests(
    householdId: HouseholdId,
    status?: GroceryRequest['status'],
  ): Promise<GroceryRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.householdId === householdId && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async createGroceryRequest(
    householdId: HouseholdId,
    input: { itemText: string; quantityText: string | null },
    createdById: MembershipId,
  ): Promise<{ request: GroceryRequest; event: SystemEvent }> {
    const request: GroceryRequest = {
      id: id<'GroceryRequestId'>(crypto.randomUUID()),
      householdId,
      itemText: input.itemText,
      quantityText: input.quantityText,
      status: 'pending',
      createdById,
      createdAt: this.now(),
      resolvedById: null,
      resolvedAt: null,
      version: 1,
    };
    this.requests.set(request.id as string, request);
    const event = await this.appendSystemEvent(householdId, {
      type: 'grocery_request.created',
      actorId: createdById,
      entityType: 'grocery_request',
      entityId: request.id as string,
      payload: { item: input.itemText, quantity: input.quantityText, status: 'pending' },
    });
    return { request, event };
  }
  async updateGroceryRequest(
    householdId: HouseholdId,
    requestId: GroceryRequestId,
    expectedVersion: number,
    patch: Partial<GroceryRequest>,
    actor: MembershipId,
  ): Promise<{ request: GroceryRequest; event: SystemEvent }> {
    const r = this.requests.get(requestId as string);
    if (!r || r.householdId !== householdId) throw new Error('not_found');
    if (r.version !== expectedVersion) {
      throw Object.assign(new Error('conflict'), { code: 'conflict', current: r });
    }
    const updated: GroceryRequest = {
      ...r,
      ...patch,
      resolvedById: patch.status && patch.status !== 'pending' ? actor : r.resolvedById,
      resolvedAt: patch.status && patch.status !== 'pending' ? this.now() : r.resolvedAt,
      version: r.version + 1,
    };
    this.requests.set(r.id as string, updated);
    const type =
      updated.status === 'approved'
        ? 'grocery_request.approved'
        : updated.status === 'rejected'
          ? 'grocery_request.rejected'
          : updated.status === 'cancelled'
            ? 'grocery_request.cancelled'
            : updated.status === 'in_order'
              ? 'grocery_request.in_order'
              : updated.status === 'fulfilled'
                ? 'grocery_request.fulfilled'
                : 'grocery_request.updated';
    const event = await this.appendSystemEvent(householdId, {
      type,
      actorId: actor,
      entityType: 'grocery_request',
      entityId: updated.id as string,
      payload: { item: updated.itemText, quantity: updated.quantityText, status: updated.status },
    });
    return { request: updated, event };
  }

  async getSuggestedCart(householdId: HouseholdId): Promise<SuggestedCartItem[]> {
    return [...this.cartItems.values()]
      .filter((c) => c.householdId === householdId)
      .sort((a, b) => a.needDay.localeCompare(b.needDay));
  }
  async replaceSuggestedCart(
    householdId: HouseholdId,
    items: SuggestedCartItem[],
  ): Promise<SuggestedCartItem[]> {
    for (const c of [...this.cartItems.values()]) {
      if (c.householdId === householdId) this.cartItems.delete(c.id);
    }
    for (const item of items) this.cartItems.set(item.id, { ...item, householdId });
    return items;
  }
  async setCartItemState(
    householdId: HouseholdId,
    itemId: string,
    memberState: SuggestedCartItem['memberState'],
    reason: SuggestedCartItem['removalReason'],
  ): Promise<void> {
    const c = this.cartItems.get(itemId);
    if (c && c.householdId === householdId) {
      this.cartItems.set(itemId, { ...c, memberState, removalReason: reason });
    }
  }
  async appendPantryLedger(
    householdId: HouseholdId,
    entry: Omit<PantryLedgerEntry, 'id' | 'householdId'>,
  ): Promise<void> {
    this.ledger.push({ ...entry, id: crypto.randomUUID(), householdId });
  }
  async replaceConsumptionLedger(
    householdId: HouseholdId,
    entries: Omit<PantryLedgerEntry, 'id' | 'householdId'>[],
  ): Promise<void> {
    const kept = this.ledger.filter(
      (e) => !(e.householdId === householdId && e.source === 'consumption'),
    );
    for (const entry of entries) {
      kept.push({ ...entry, id: crypto.randomUUID(), householdId });
    }
    this.ledger.length = 0;
    this.ledger.push(...kept);
  }
  async listPantryLedger(
    householdId: HouseholdId,
    ingredientKey: string,
  ): Promise<PantryLedgerEntry[]> {
    return this.ledger
      .filter((e) => e.householdId === householdId && e.ingredientKey === ingredientKey)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  async getChatTimeline(
    householdId: HouseholdId,
    afterId: ChatMessageId | null,
    limit: number,
  ): Promise<TimelineItem[]> {
    const msgs: TimelineItem[] = [...this.messages.values()]
      .filter((m) => m.householdId === householdId)
      .map((message) => ({
        kind: 'message' as const,
        message,
        transcript: this.transcripts.get(message.id as string) ?? null,
      }));
    const evs: TimelineItem[] = this.events
      .filter((e) => e.householdId === householdId)
      .map((event) => ({ kind: 'event' as const, event }));
    const merged = [...msgs, ...evs].sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
    if (afterId) {
      const idx = merged.findIndex((t) => idOf(t) === (afterId as string));
      return idx >= 0 ? merged.slice(idx + 1, idx + 1 + limit) : [];
    }
    return merged.slice(-limit);
  }
  async getMessage(id: ChatMessageId): Promise<ChatMessage | null> {
    return this.messages.get(id as string) ?? null;
  }
  async getTranscript(messageId: ChatMessageId): Promise<VoiceTranscript | null> {
    return this.transcripts.get(messageId as string) ?? null;
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
  ): Promise<ChatMessage> {
    const m: ChatMessage = {
      id: id<'ChatMessageId'>(crypto.randomUUID()),
      householdId,
      senderId: input.senderId,
      kind: input.kind,
      body: input.body,
      caption: input.caption,
      mediaRef: input.mediaRef,
      clientCreatedAt: input.clientCreatedAt,
      serverCreatedAt: this.now(),
      editedAt: null,
      deletedAt: null,
    };
    this.messages.set(m.id as string, m);
    return m;
  }
  async editMessage(
    householdId: HouseholdId,
    msgId: ChatMessageId,
    senderId: MembershipId,
    patch: { body?: string | null; caption?: string | null },
  ): Promise<ChatMessage> {
    const m = this.messages.get(msgId as string);
    if (!m || m.householdId !== householdId || m.senderId !== senderId)
      throw new Error('forbidden');
    const updated = { ...m, ...patch, editedAt: this.now() };
    this.messages.set(m.id as string, updated);
    return updated;
  }
  async deleteMessage(
    householdId: HouseholdId,
    msgId: ChatMessageId,
    senderId: MembershipId,
  ): Promise<ChatMessage> {
    const m = this.messages.get(msgId as string);
    if (!m || m.householdId !== householdId || m.senderId !== senderId)
      throw new Error('forbidden');
    const updated = { ...m, deletedAt: this.now(), mediaRef: null };
    this.messages.set(m.id as string, updated);
    return updated;
  }
  async setTranscript(
    messageId: ChatMessageId,
    transcript: VoiceTranscript,
  ): Promise<VoiceTranscript> {
    this.transcripts.set(messageId as string, transcript);
    return transcript;
  }
  async appendSystemEvent(
    householdId: HouseholdId,
    event: Omit<SystemEvent, 'id' | 'createdAt' | 'householdId'>,
  ): Promise<SystemEvent> {
    const e: SystemEvent = {
      ...event,
      id: id<'SystemEventId'>(crypto.randomUUID()),
      householdId,
      createdAt: this.now(),
    };
    this.events.push(e);
    return e;
  }

  async createSuggestion(
    householdId: HouseholdId,
    input: Omit<ActionSuggestion, 'id' | 'createdAt' | 'householdId' | 'status'>,
  ): Promise<ActionSuggestion> {
    const s: ActionSuggestion = {
      ...input,
      id: id<'SuggestionId'>(crypto.randomUUID()),
      householdId,
      status: 'pending',
      createdAt: this.now(),
    };
    this.suggestions.set(s.id as string, s);
    return s;
  }
  async getSuggestion(id: string): Promise<ActionSuggestion | null> {
    return this.suggestions.get(id) ?? null;
  }
  async listPendingSuggestions(authorId: MembershipId): Promise<ActionSuggestion[]> {
    return [...this.suggestions.values()].filter(
      (s) => s.authorId === authorId && s.status === 'pending',
    );
  }
  async updateSuggestionStatus(
    householdId: HouseholdId,
    id: string,
    status: ActionSuggestion['status'],
  ): Promise<void> {
    const s = this.suggestions.get(id);
    if (s && s.householdId === householdId) this.suggestions.set(id, { ...s, status });
  }

  async getMemberState(
    userId: UserId,
    householdId: HouseholdId,
  ): Promise<HouseholdMemberState | null> {
    return this.memberState.get(`${userId}:${householdId}`) ?? null;
  }
  async markRead(userId: UserId, householdId: HouseholdId, upTo: ChatMessageId): Promise<void> {
    const key = `${userId}:${householdId}`;
    const existing = this.memberState.get(key);
    this.memberState.set(key, {
      userId,
      householdId,
      lastReadMessageId: upTo,
      notificationOverride: existing?.notificationOverride ?? null,
    });
  }
  async setNotificationOverride(
    userId: UserId,
    householdId: HouseholdId,
    override: NotificationLevel | null,
  ): Promise<HouseholdMemberState> {
    const key = `${userId}:${householdId}`;
    const existing = this.memberState.get(key);
    const state: HouseholdMemberState = {
      userId,
      householdId,
      lastReadMessageId: existing?.lastReadMessageId ?? null,
      notificationOverride: override,
    };
    this.memberState.set(key, state);
    return state;
  }
  async invalidateDevice(deviceId: DeviceId): Promise<void> {
    const d = this.devices.get(deviceId as string);
    if (d) this.devices.set(deviceId as string, { ...d, invalidatedAt: this.now() });
  }
  async registerDevice(device: Omit<DeviceRegistration, 'id'>): Promise<DeviceRegistration> {
    const d: DeviceRegistration = { ...device, id: id<'DeviceId'>(crypto.randomUUID()) };
    this.devices.set(d.id as string, d);
    return d;
  }
  async listDevices(userId: UserId): Promise<DeviceRegistration[]> {
    return [...this.devices.values()].filter((d) => d.userId === userId && !d.invalidatedAt);
  }

  async createOrder(
    householdId: HouseholdId,
    placedById: MembershipId,
    input: {
      providerOrderId: string | null;
      status: GroceryOrder['status'];
      totalCents: number | null;
    },
  ): Promise<GroceryOrder> {
    const o: GroceryOrder = {
      id: id<'GroceryOrderId'>(crypto.randomUUID()),
      householdId,
      placedById,
      providerOrderId: input.providerOrderId,
      status: input.status,
      totalCents: input.totalCents,
      createdAt: this.now(),
    };
    this.orders.set(o.id as string, o);
    return o;
  }
  async getOrder(orderId: string): Promise<GroceryOrder | null> {
    return this.orders.get(orderId) ?? null;
  }
  async listOrders(householdId: HouseholdId): Promise<GroceryOrder[]> {
    return [...this.orders.values()]
      .filter((o) => o.householdId === householdId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- product matches (issue 10) ----
  async getProductMatches(householdId: HouseholdId): Promise<ProductMatch[]> {
    return [...this.productMatches.values()].filter((m) => m.householdId === householdId);
  }
  async upsertProductMatch(match: ProductMatch): Promise<ProductMatch> {
    // Key by householdId + cartItemId so a re-choice replaces the prior match.
    const key = `${match.householdId}:${match.cartItemId}`;
    this.productMatches.set(key, match);
    return match;
  }
  async clearProductMatch(householdId: HouseholdId, cartItemId: string): Promise<void> {
    this.productMatches.delete(`${householdId}:${cartItemId}`);
  }
  async clearProductMatches(householdId: HouseholdId): Promise<void> {
    for (const [key, m] of [...this.productMatches.entries()]) {
      if (m.householdId === householdId) this.productMatches.delete(key);
    }
  }

  // ---- orders: status reconciliation (issue 11, AC#8) ----
  async updateOrderStatus(
    householdId: HouseholdId,
    orderId: GroceryOrderId,
    status: GroceryOrder['status'],
  ): Promise<void> {
    const order = this.orders.get(orderId as string);
    if (order && order.householdId === householdId) {
      this.orders.set(orderId as string, { ...order, status });
    }
  }

  // ---- checkout attempts + audit (issue 11, AC#5) ----
  async getIdempotencyKey(key: string): Promise<IdempotencyKeyRecord | null> {
    return this.idempotencyKeys.get(key) ?? null;
  }
  async beginIdempotencyKey(input: {
    key: string;
    membershipId: MembershipId;
    householdId: HouseholdId;
  }): Promise<IdempotencyKeyRecord> {
    const existing = this.idempotencyKeys.get(input.key);
    if (existing) return existing; // unique-key semantics: observe, do not place again
    const record: IdempotencyKeyRecord = {
      key: input.key,
      membershipId: input.membershipId,
      householdId: input.householdId,
      status: 'in_flight',
      result: null,
      createdAt: this.now(),
    };
    this.idempotencyKeys.set(input.key, record);
    return record;
  }
  async completeIdempotencyKey(
    key: string,
    status: 'succeeded' | 'failed',
    result: unknown,
  ): Promise<void> {
    const record = this.idempotencyKeys.get(key);
    if (record) this.idempotencyKeys.set(key, { ...record, status, result });
  }
  async appendCheckoutAudit(
    input: Omit<CheckoutAuditRecord, 'id' | 'createdAt'>,
  ): Promise<CheckoutAuditRecord> {
    const record: CheckoutAuditRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: this.now(),
    };
    this.checkoutAudit.push(record);
    return record;
  }
  async listCheckoutAudit(householdId: HouseholdId): Promise<CheckoutAuditRecord[]> {
    return this.checkoutAudit
      .filter((r) => r.householdId === householdId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function timeOf(t: TimelineItem): string {
  return t.kind === 'message' ? t.message.serverCreatedAt : t.event.createdAt;
}
function idOf(t: TimelineItem): string {
  return t.kind === 'message' ? (t.message.id as string) : (t.event.id as string);
}
