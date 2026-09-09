import type { AuthorizationLookup } from './authorization.js';
import type {
  ChatMessageId,
  GroceryOrderId,
  GroceryRequestId,
  HouseholdId,
  MembershipId,
  PlannedMealId,
  RecipeId,
  UserId,
  DeviceId,
} from './ids.js';
import type {
  ChatMessage,
  DeviceRegistration,
  GroceryOrder,
  Household,
  HouseholdMemberState,
  IdempotencyKeyRecord,
  CheckoutAuditRecord,
  Membership,
  PantryLedgerEntry,
  PlannedMeal,
  Recipe,
  SuggestedCartItem,
  SystemEvent,
  ActionSuggestion,
  TimelineItem,
  User,
  VoiceTranscript,
  GroceryRequest,
  NotificationLevel,
} from './domain-types.js';
import type { ProductMatch } from './provider.js';

/**
 * The repository port. Every household-scoped method takes `householdId` as
 * its first argument; callers MUST pass `principal.householdId`. The
 * application server's Drizzle implementation and the test in-memory
 * implementation both satisfy this contract, and the authorization isolation
 * suite proves no method can return another household's rows.
 *
 * Writes that must be atomic across tables (e.g. "create a grocery request and
 * append its system event") are grouped in a single method so they share one
 * MySQL transaction (issue 07, AC#6 — unsharded ACID).
 */
export interface Repository extends AuthorizationLookup {
  // ---- identity ----
  getUserByClerkId(clerkUserId: string): Promise<User | null>;
  createUser(user: Omit<User, 'createdAt'> & { createdAt?: string }): Promise<User>;
  getHousehold(householdId: HouseholdId): Promise<Household | null>;
  listHouseholdsForUser(
    userId: UserId,
  ): Promise<{ household: Household; membership: Membership }[]>;
  createHousehold(
    household: Omit<Household, 'id' | 'createdAt' | 'closedAt'>,
    ownerId: UserId,
  ): Promise<{ household: Household; ownerMembership: Membership }>;

  // ---- membership ----
  getMembership(membershipId: MembershipId): Promise<Membership | null>;
  listMembers(householdId: HouseholdId): Promise<Membership[]>;
  addMembership(
    householdId: HouseholdId,
    userId: UserId,
    role: Membership['role'],
  ): Promise<Membership>;
  removeMembership(membershipId: MembershipId): Promise<void>;
  /** Active cooks in a household (max two — issue: accounts & roles). */
  countActiveCooks(householdId: HouseholdId): Promise<number>;
  countActiveHouseholdsForCook(userId: UserId): Promise<number>;

  // ---- meal plan ----
  getPlannedMeal(id: PlannedMealId): Promise<PlannedMeal | null>;
  listMealsForRange(
    householdId: HouseholdId,
    startDate: string,
    endDate: string,
  ): Promise<PlannedMeal[]>;
  listMealsForDay(householdId: HouseholdId, date: string): Promise<PlannedMeal[]>;
  upsertPlannedMeal(
    householdId: HouseholdId,
    meal: Omit<PlannedMeal, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'householdId'>,
    actor: MembershipId,
  ): Promise<PlannedMeal>;
  /** Optimistic-concurrency update (issue 04/06). */
  updatePlannedMeal(
    householdId: HouseholdId,
    id: PlannedMealId,
    expectedVersion: number,
    patch: Partial<PlannedMeal>,
    actor: MembershipId,
  ): Promise<PlannedMeal>;
  replaceMealPlanRange(
    householdId: HouseholdId,
    startDate: string,
    meals: Omit<PlannedMeal, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'householdId'>[],
    actor: MembershipId,
  ): Promise<PlannedMeal[]>;

  // ---- recipes ----
  getRecipe(id: RecipeId): Promise<Recipe | null>;
  searchRecipesForDiet(
    query: string,
    householdDietStyle: Household['dietStyle'],
  ): Promise<Recipe[]>;

  // ---- grocery requests ----
  getGroceryRequest(id: GroceryRequestId): Promise<GroceryRequest | null>;
  listGroceryRequests(
    householdId: HouseholdId,
    status?: GroceryRequest['status'],
  ): Promise<GroceryRequest[]>;
  createGroceryRequest(
    householdId: HouseholdId,
    input: { itemText: string; quantityText: string | null },
    createdById: MembershipId,
  ): Promise<{ request: GroceryRequest; event: SystemEvent }>;
  updateGroceryRequest(
    householdId: HouseholdId,
    id: GroceryRequestId,
    expectedVersion: number,
    patch: Partial<GroceryRequest>,
    actor: MembershipId,
  ): Promise<{ request: GroceryRequest; event: SystemEvent }>;

  // ---- suggested cart + pantry ----
  getSuggestedCart(householdId: HouseholdId): Promise<SuggestedCartItem[]>;
  replaceSuggestedCart(
    householdId: HouseholdId,
    items: SuggestedCartItem[],
  ): Promise<SuggestedCartItem[]>;
  setCartItemState(
    householdId: HouseholdId,
    itemId: string,
    state: SuggestedCartItem['memberState'],
    reason: SuggestedCartItem['removalReason'] | null,
  ): Promise<void>;
  appendPantryLedger(
    householdId: HouseholdId,
    entry: Omit<PantryLedgerEntry, 'id' | 'householdId'>,
  ): Promise<void>;
  /**
   * Replace all `consumption`-source ledger entries for a Household with the
   * given derived entries (issue 09, AC#2 — recalculated after structured plan
   * changes). Other sources (`order_delivered`, `request_override`,
   * `member_edit`) are preserved.
   */
  replaceConsumptionLedger(
    householdId: HouseholdId,
    entries: Omit<PantryLedgerEntry, 'id' | 'householdId'>[],
  ): Promise<void>;
  listPantryLedger(householdId: HouseholdId, ingredientKey: string): Promise<PantryLedgerEntry[]>;

  // ---- chat ----
  getChatTimeline(
    householdId: HouseholdId,
    afterId: ChatMessageId | null,
    limit: number,
  ): Promise<TimelineItem[]>;
  getMessage(id: ChatMessageId): Promise<ChatMessage | null>;
  getTranscript(messageId: ChatMessageId): Promise<VoiceTranscript | null>;
  createMessage(
    householdId: HouseholdId,
    input: {
      senderId: MembershipId;
      kind: ChatMessage['kind'];
      body: string | null;
      caption: string | null;
      mediaRef: string | null;
      clientCreatedAt: string;
    },
  ): Promise<ChatMessage>;
  editMessage(
    householdId: HouseholdId,
    id: ChatMessageId,
    senderId: MembershipId,
    patch: { body?: string | null; caption?: string | null },
  ): Promise<ChatMessage>;
  deleteMessage(
    householdId: HouseholdId,
    id: ChatMessageId,
    senderId: MembershipId,
  ): Promise<ChatMessage>;
  setTranscript(messageId: ChatMessageId, transcript: VoiceTranscript): Promise<VoiceTranscript>;
  appendSystemEvent(
    householdId: HouseholdId,
    event: Omit<SystemEvent, 'id' | 'createdAt' | 'householdId'>,
  ): Promise<SystemEvent>;

  // ---- suggestions ----
  createSuggestion(
    householdId: HouseholdId,
    input: Omit<ActionSuggestion, 'id' | 'createdAt' | 'householdId' | 'status'>,
  ): Promise<ActionSuggestion>;
  getSuggestion(id: string): Promise<ActionSuggestion | null>;
  listPendingSuggestions(authorId: MembershipId): Promise<ActionSuggestion[]>;
  updateSuggestionStatus(
    householdId: HouseholdId,
    id: string,
    status: ActionSuggestion['status'],
  ): Promise<void>;

  // ---- member state + devices ----
  getMemberState(userId: UserId, householdId: HouseholdId): Promise<HouseholdMemberState | null>;
  /**
   * Set the per-household notification override for a user (issue 12, AC#2).
   * A null override restores the role default.
   */
  setNotificationOverride(
    userId: UserId,
    householdId: HouseholdId,
    override: NotificationLevel | null,
  ): Promise<HouseholdMemberState>;
  markRead(userId: UserId, householdId: HouseholdId, upTo: ChatMessageId): Promise<void>;
  registerDevice(device: Omit<DeviceRegistration, 'id'>): Promise<DeviceRegistration>;
  listDevices(userId: UserId): Promise<DeviceRegistration[]>;
  /**
   * Invalidate a device token (issue 12, AC#8). Retired tokens never receive
   * pushes; the row is preserved for audit.
   */
  invalidateDevice(deviceId: DeviceId): Promise<void>;

  // ---- orders ----
  createOrder(
    householdId: HouseholdId,
    placedById: MembershipId,
    input: {
      providerOrderId: string | null;
      status: GroceryOrder['status'];
      totalCents: number | null;
    },
  ): Promise<GroceryOrder>;
  getOrder(id: GroceryOrderId | string): Promise<GroceryOrder | null>;
  listOrders(householdId: HouseholdId): Promise<GroceryOrder[]>;
  /** Reconcile a Cooklink order row with live provider status (issue 11, AC#8). */
  updateOrderStatus(
    householdId: HouseholdId,
    orderId: GroceryOrderId,
    status: GroceryOrder['status'],
  ): Promise<void>;

  // ---- checkout attempts + audit (issue 11, AC#5) ----
  /**
   * Read an existing idempotency-key attempt. A non-null result means a prior
   * attempt with the same key exists and MUST be observed instead of placing
   * again (AC#5 — unique checkout attempt prevents blind duplicate submission).
   */
  getIdempotencyKey(key: string): Promise<IdempotencyKeyRecord | null>;
  /**
   * Insert an `in_flight` attempt. The unique key constraint MUST prevent a
   * duplicate insert; the caller treats a duplicate as an existing attempt to
   * observe (AC#5).
   */
  beginIdempotencyKey(input: {
    key: string;
    membershipId: MembershipId;
    householdId: HouseholdId;
  }): Promise<IdempotencyKeyRecord>;
  /** Mark an attempt succeeded/failed with the result payload (AC#5). */
  completeIdempotencyKey(
    key: string,
    status: 'succeeded' | 'failed',
    result: unknown,
  ): Promise<void>;
  /** Append a checkout audit row. Append-only — never update or delete (AC#5). */
  appendCheckoutAudit(
    input: Omit<CheckoutAuditRecord, 'id' | 'createdAt'>,
  ): Promise<CheckoutAuditRecord>;
  /** List the append-only checkout audit for a Household (visibility). */
  listCheckoutAudit(householdId: HouseholdId): Promise<CheckoutAuditRecord[]>;

  // ---- product matches (issue 10) ----
  /**
   * Load all product matches for a Household's current Suggested Grocery Cart.
   * Each match links a cart line to an exact Instamart product the Member chose.
   */
  getProductMatches(householdId: HouseholdId): Promise<ProductMatch[]>;
  /**
   * Persist (or replace) a Member's exact product choice for one cart line
   * (AC#3 — a vague need stays unresolved until a product is chosen).
   */
  upsertProductMatch(match: ProductMatch): Promise<ProductMatch>;
  /** Remove a product match (e.g. when the cart is rebuilt or a match is cleared). */
  clearProductMatch(householdId: HouseholdId, cartItemId: string): Promise<void>;
  /** Remove all product matches for a Household (used on cart rebuild). */
  clearProductMatches(householdId: HouseholdId): Promise<void>;
}
