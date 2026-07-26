import type {
  ChatMessageId,
  GroceryOrderId,
  GroceryRequestId,
  HouseholdId,
  MembershipId,
  PlannedMealId,
  RecipeId,
  SuggestionId,
  SystemEventId,
  UserId,
  DeviceId,
} from './ids.js';
import type { HouseholdRole } from './roles.js';

export type ISODate = string; // YYYY-MM-DD calendar date
export type ISODateTime = string; // ISO 8601 timestamp

export type MealType = 'breakfast' | 'lunch' | 'dinner';
export const MEAL_TYPES: readonly MealType[] = ['breakfast', 'lunch', 'dinner'];

export type DietStyle = 'vegetarian' | 'eggetarian' | 'nonvegetarian';
export type MealStyle = 'north' | 'south';
export type Language = 'en' | 'hi';

/** The most restrictive diet style wins for shared meal generation (issue 04). */
export function mostRestrictive(styles: DietStyle[]): DietStyle {
  if (styles.includes('vegetarian')) return 'vegetarian';
  if (styles.includes('eggetarian')) return 'eggetarian';
  return 'nonvegetarian';
}

export interface User {
  id: UserId;
  clerkUserId: string;
  phone: string;
  displayName: string;
  createdAt: ISODateTime;
}

export interface Household {
  id: HouseholdId;
  name: string;
  photoUrl: string | null;
  servingCount: number;
  mealStyle: MealStyle;
  dietStyle: DietStyle;
  /** Soft chips: 'higher_protein' | 'more_vegetables' | 'lighter_meals' ... */
  healthEmphasis: string[];
  specialMealEnabled: boolean;
  defaultLanguage: Language;
  createdAt: ISODateTime;
  closedAt: ISODateTime | null;
}

export type MembershipStatus = 'active' | 'removed';

export interface Membership {
  id: MembershipId;
  userId: UserId;
  householdId: HouseholdId;
  role: HouseholdRole;
  status: MembershipStatus;
  /** Per-role default applied to new households (issue 06). */
  notificationDefault: NotificationLevel;
  joinedAt: ISODateTime;
  removedAt: ISODateTime | null;
}

export type NotificationLevel = 'all' | 'important' | 'muted';

/** A food the household or a member chooses to avoid (issue 04 inputs). */
export interface FoodAvoidance {
  id: string;
  householdId: HouseholdId;
  userId: UserId | null; // null = household-level
  food: string;
}

export interface RecipeIngredient {
  name: string;
  /** Stable pantry key for normalization, e.g. "tomato". Null = unnormalizable. */
  ingredientKey: string | null;
  /** dependable quantity at {@link Recipe.baseServings}. */
  quantity: number | null;
  unit: 'g' | 'ml' | 'count' | null;
  dependable: boolean;
  adjustToTaste: boolean;
}

export type RecipeProvenance = 'verified' | 'ai_draft';

export interface Recipe {
  id: RecipeId;
  name: string;
  nameHi: string | null;
  baseServings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  stepsHi: string[] | null;
  provenance: RecipeProvenance;
  dietStyle: DietStyle;
  mealStyle: MealStyle | null;
  mealTypes: MealType[];
}

export interface PlannedMeal {
  id: PlannedMealId;
  householdId: HouseholdId;
  date: ISODate;
  mealType: MealType;
  recipeId: RecipeId | null;
  name: string;
  servings: number;
  /** Whether servings was overridden for this slot. */
  servingsOverridden: boolean;
  isSpecial: boolean;
  /** Optimistic-concurrency version (issue 04/06). */
  version: number;
  updatedBy: MembershipId | null;
  updatedAt: ISODateTime;
}

export type GroceryRequestStatus =
  'pending' | 'approved' | 'rejected' | 'cancelled' | 'in_order' | 'fulfilled';

export interface GroceryRequest {
  id: GroceryRequestId;
  householdId: HouseholdId;
  itemText: string;
  quantityText: string | null;
  status: GroceryRequestStatus;
  createdById: MembershipId;
  createdAt: ISODateTime;
  resolvedById: MembershipId | null;
  resolvedAt: ISODateTime | null;
  version: number;
}

export type PantryConfidence = 'likely_available' | 'may_be_low' | 'unknown';

export type CartNeedDay = 'today' | 'tomorrow' | 'day_after';

export interface SuggestedCartItem {
  id: string;
  householdId: HouseholdId;
  ingredientKey: string | null;
  /** Linked approved grocery request, if this row came from a Cook request. */
  groceryRequestId: GroceryRequestId | null;
  freeTextItem: string | null;
  needDay: CartNeedDay;
  affectedMeals: { date: ISODate; mealType: MealType; name: string }[];
  confidence: PantryConfidence;
  memberState: 'pending' | 'kept' | 'removed';
  removalReason: 'already_have' | 'not_needed' | 'buy_later' | null;
}

export type LedgerDeltaSource =
  'order_delivered' | 'consumption' | 'request_override' | 'member_edit';

export interface PantryLedgerEntry {
  id: string;
  householdId: HouseholdId;
  ingredientKey: string;
  deltaG: number | null;
  deltaMl: number | null;
  deltaCount: number | null;
  source: LedgerDeltaSource;
  perishable: boolean;
  freshnessDays: number | null;
  at: ISODateTime;
}

export type ChatMessageKind = 'text' | 'photo' | 'voice';

export interface ChatMessage {
  id: ChatMessageId;
  householdId: HouseholdId;
  senderId: MembershipId;
  kind: ChatMessageKind;
  body: string | null;
  caption: string | null;
  mediaRef: string | null;
  clientCreatedAt: ISODateTime;
  serverCreatedAt: ISODateTime;
  editedAt: ISODateTime | null;
  deletedAt: ISODateTime | null;
}

export interface VoiceTranscript {
  messageId: ChatMessageId;
  language: Language | null;
  transcript: string | null;
  status: 'pending' | 'ready' | 'failed';
  correctedTranscript: string | null;
}

export type SystemEventType =
  | 'meal.changed'
  | 'meal_plan.bulk_updated'
  | 'grocery_request.created'
  | 'grocery_request.updated'
  | 'grocery_request.cancelled'
  | 'grocery_request.approved'
  | 'grocery_request.rejected'
  | 'grocery_request.in_order'
  | 'grocery_request.fulfilled'
  | 'grocery_order.placed'
  | 'grocery_order.failed'
  | 'grocery_order.delivery_updated'
  | 'membership.joined'
  | 'membership.removed';

export interface SystemEvent {
  id: SystemEventId;
  householdId: HouseholdId;
  type: SystemEventType;
  actorId: MembershipId | null;
  entityType: string;
  entityId: string;
  /** Safe rendering payload — NEVER money (issue 06, AC#24). */
  payload: Record<string, unknown>;
  createdAt: ISODateTime;
}

export interface ActionSuggestion {
  id: SuggestionId;
  householdId: HouseholdId;
  authorId: MembershipId;
  sourceMessageId: ChatMessageId | null;
  intent: ChatIntent;
  status: 'pending' | 'confirmed' | 'dismissed' | 'expired' | 'failed';
  expiresAt: ISODateTime;
  createdAt: ISODateTime;
}

export interface HouseholdMemberState {
  userId: UserId;
  householdId: HouseholdId;
  lastReadMessageId: ChatMessageId | null;
  notificationOverride: NotificationLevel | null;
}

export interface DeviceRegistration {
  id: DeviceId;
  userId: UserId;
  pushToken: string;
  platform: 'ios' | 'android';
  hidePreviews: boolean;
  invalidatedAt: ISODateTime | null;
}

export type ChatIntent =
  | { kind: 'grocery_request'; item: string; quantity: string | null }
  | { kind: 'add_to_cart'; item: string; quantity: string | null }
  | { kind: 'meal_change'; date: ISODate | null; mealType: MealType | null; meal: string | null }
  | { kind: 'unknown' };

export interface GroceryOrder {
  id: GroceryOrderId;
  householdId: HouseholdId;
  placedById: MembershipId;
  providerOrderId: string | null;
  status: 'pending' | 'placed' | 'failed' | 'delivered';
  totalCents: number | null;
  createdAt: ISODateTime;
}

/** A timeline item is either a human message or a system event (issue 06). */
export type TimelineItem =
  | { kind: 'message'; message: ChatMessage; transcript: VoiceTranscript | null }
  | { kind: 'event'; event: SystemEvent };
