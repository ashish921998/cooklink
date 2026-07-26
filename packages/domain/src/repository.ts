import type {
  AuthorizationLookup,
} from './authorization.js';
import type {
  ChatMessageId,
  DeviceId,
  GroceryOrderId,
  GroceryRequestId,
  HouseholdId,
  MembershipId,
  PlannedMealId,
  RecipeId,
  SuggestionId,
  SystemEventId,
  UserId,
} from './ids.js';
import type {
  ChatMessage,
  DeviceRegistration,
  GroceryOrder,
  Household,
  HouseholdMemberState,
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
} from './types.js';

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
  listHouseholdsForUser(userId: UserId): Promise<{ household: Household; membership: Membership }[]>;
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
  appendPantryLedger(householdId: HouseholdId, entry: Omit<PantryLedgerEntry, 'id' | 'householdId'>): Promise<void>;
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
  setTranscript(
    messageId: ChatMessageId,
    transcript: VoiceTranscript,
  ): Promise<VoiceTranscript>;
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
  getMemberState(
    userId: UserId,
    householdId: HouseholdId,
  ): Promise<HouseholdMemberState | null>;
  markRead(userId: UserId, householdId: HouseholdId, upTo: ChatMessageId): Promise<void>;
  registerDevice(device: Omit<DeviceRegistration, 'id'>): Promise<DeviceRegistration>;
  listDevices(userId: UserId): Promise<DeviceRegistration[]>;

  // ---- orders ----
  createOrder(
    householdId: HouseholdId,
    placedById: MembershipId,
    input: { providerOrderId: string | null; status: GroceryOrder['status']; totalCents: number | null },
  ): Promise<GroceryOrder>;
  getOrder(id: GroceryOrderId | string): Promise<GroceryOrder | null>;
  listOrders(householdId: HouseholdId): Promise<GroceryOrder[]>;
}
