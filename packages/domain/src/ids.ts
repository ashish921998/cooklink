/**
 * Branded identifier types.
 *
 * These are nominal strings so that a {@link UserId} can never be accidentally
 * passed where a {@link HouseholdId} is expected. The application server and
 * database layers cast raw strings into these brands on read; nothing about
 * authorization depends on the brand, but it removes a large class of
 * "wrong id" bugs that would silently cross Household boundaries.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type HouseholdId = Brand<string, 'HouseholdId'>;
export type MembershipId = Brand<string, 'MembershipId'>;
export type PlannedMealId = Brand<string, 'PlannedMealId'>;
export type RecipeId = Brand<string, 'RecipeId'>;
export type GroceryRequestId = Brand<string, 'GroceryRequestId'>;
export type ChatMessageId = Brand<string, 'ChatMessageId'>;
export type SystemEventId = Brand<string, 'SystemEventId'>;
export type SuggestionId = Brand<string, 'SuggestionId'>;
export type GroceryOrderId = Brand<string, 'GroceryOrderId'>;
export type DeviceId = Brand<string, 'DeviceId'>;

/** Cast a raw string (from the DB, URL, or JSON) into a branded id. */
export function brandId<B extends string>(value: string): Brand<string, B> {
  return value as Brand<string, B>;
}
