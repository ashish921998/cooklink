/**
 * Suggested Grocery Cart API routes (ticket 09).
 *
 * The editable proposal for the next three days of planned meals, built from
 * the Estimated Pantry and approved Grocery Requests. Every line explains the
 * affected meal and need day; likely-available ingredients are omitted;
 * uncertain items appear as "Check at home". Members keep or remove lines
 * with an optional removal reason. It becomes a Grocery Order only after a
 * Member reviews and confirms checkout — never automatically.
 */
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { brandId, refreshSuggestedCart, todayISO } from '@cooklink/domain';
import { DrizzleRepository, suggestedCartItems } from '@cooklink/db';
import type { SuggestedCartItem } from '@cooklink/domain';
import type { AuthEnv } from '../auth.js';
import type { AppRouteContext } from './route-context.js';

/** Mount the suggested-cart routes: three-day proposal and keep/remove edits. */
export function registerSuggestedCartRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization } = ctx;

  /**
   * The Suggested Grocery Cart for today plus the next two calendar days
   * (ticket 09). All active participants may view it. The endpoint rebuilds
   * the Estimated Pantry consumption ledger from the current plan and then
   * produces the cart.
   */
  app.get('/v1/households/:householdId/suggested-cart', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const repo = new DrizzleRepository(db);
    const items = await refreshSuggestedCart(repo, principal.householdId, todayISO(), new Date());
    return c.json({ items: items.map(serializeSuggestedCartItem) });
  });

  /**
   * A Household Member keeps or removes a cart line without opening a separate
   * pantry screen (ticket 09, AC#6). An optional removal reason improves later
   * estimates without requiring routine stock entry (AC#7). Cooks cannot edit
   * the cart (capability `add_to_cart` is Member/Owner only).
   */
  app.patch('/v1/households/:householdId/suggested-cart/:itemId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'add_to_cart',
    );
    const itemId = c.req.param('itemId');
    const body: {
      state?: 'kept' | 'removed';
      removalReason?: 'already_have' | 'not_needed' | 'buy_later' | null;
    } = await c.req.json().catch(() => ({}));
    if (body.state !== 'kept' && body.state !== 'removed') {
      return c.json({ error: 'state_required' }, 400);
    }
    const ALLOWED_REMOVAL_REASONS = new Set(['already_have', 'not_needed', 'buy_later']);
    const removalReason =
      body.removalReason && ALLOWED_REMOVAL_REASONS.has(body.removalReason)
        ? (body.removalReason as 'already_have' | 'not_needed' | 'buy_later')
        : null;

    const [existing] = await db
      .select()
      .from(suggestedCartItems)
      .where(
        and(
          eq(suggestedCartItems.id, itemId),
          eq(suggestedCartItems.householdId, principal.householdId),
        ),
      )
      .limit(1);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    await db
      .update(suggestedCartItems)
      .set({ memberState: body.state, removalReason })
      .where(
        and(
          eq(suggestedCartItems.id, itemId),
          eq(suggestedCartItems.householdId, principal.householdId),
        ),
      );
    const [updated] = await db
      .select()
      .from(suggestedCartItems)
      .where(
        and(
          eq(suggestedCartItems.id, itemId),
          eq(suggestedCartItems.householdId, principal.householdId),
        ),
      )
      .limit(1);
    return c.json({ item: serializeSuggestedCartItem(toDomainCartItem(updated!)) });
  });
}

/** Map a Drizzle suggested-cart row onto the domain `SuggestedCartItem`. */
export function toDomainCartItem(row: typeof suggestedCartItems.$inferSelect): SuggestedCartItem {
  return {
    id: row.id,
    householdId: brandId<'HouseholdId'>(row.householdId),
    ingredientKey: row.ingredientKey,
    groceryRequestId: row.groceryRequestId
      ? brandId<'GroceryRequestId'>(row.groceryRequestId)
      : null,
    freeTextItem: row.freeTextItem,
    needDay: row.needDay as SuggestedCartItem['needDay'],
    affectedMeals: row.affectedMeals as SuggestedCartItem['affectedMeals'],
    confidence: row.confidence as SuggestedCartItem['confidence'],
    memberState: row.memberState as SuggestedCartItem['memberState'],
    removalReason: (row.removalReason ?? null) as SuggestedCartItem['removalReason'],
  };
}

/** Serialize a Suggested Grocery Cart item for the API (ticket 09). */
export function serializeSuggestedCartItem(item: SuggestedCartItem) {
  return {
    id: item.id,
    ingredientKey: item.ingredientKey,
    groceryRequestId: item.groceryRequestId ? (item.groceryRequestId as string) : null,
    freeTextItem: item.freeTextItem,
    needDay: item.needDay,
    affectedMeals: item.affectedMeals,
    confidence: item.confidence,
    memberState: item.memberState,
    removalReason: item.removalReason,
    checkAtHome: item.confidence !== 'likely_available',
  };
}
