/**
 * Instamart cart synchronization API routes (issue 10, AC#4/AC#6).
 *
 * Build the Instamart cart from the Member's chosen product matches — with a
 * deliberate `preserve` (keep unrelated items already in the Instamart cart)
 * or `replace` choice — then read back the final cart review: every item,
 * quantity, bill breakdown, address, store count, and only payment methods
 * returned by the provider. Cooklink never silently erases unrelated items.
 */
import type { Hono } from 'hono';
import {
  brandId,
  buildCartUpdatePlan,
  orderableCartItems,
  refreshSuggestedCart,
  todayISO,
  validateCartReview,
  ProviderError,
  type ProviderCartItem,
  type ProviderCartReview,
} from '@cooklink/domain';
import { DrizzleRepository } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { providerErrorStatus } from './grocery-provider.routes.js';
import type { AppRouteContext } from './route-context.js';

/** Mount the Instamart cart routes: build (preserve/replace), review, clear. */
export function registerGroceryCartRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization, provider } = ctx;

  /**
   * AC#4 — build the Instamart cart from the Member's chosen products. The
   * Member deliberately chooses `preserve` (keep unrelated items already in
   * the Instamart cart) or `replace` (replace the full cart). Cooklink never
   * silently erases unrelated items.
   */
  app.post('/v1/households/:householdId/grocery-provider/cart/build', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const body: {
      addressId?: string;
      mode?: 'preserve' | 'replace';
    } = await c.req.json().catch(() => ({}));
    if (!body.addressId) return c.json({ error: 'address_id_required' }, 400);
    const mode = body.mode === 'replace' ? 'replace' : 'preserve';

    const repo = new DrizzleRepository(db);
    const keptCartItems = orderableCartItems(
      await refreshSuggestedCart(repo, principal.householdId, todayISO(), new Date()),
    );
    const keptIds = new Set(keptCartItems.map((item) => item.id));
    const matches = (await repo.getProductMatches(principal.householdId)).filter(
      (match) => keptIds.has(match.cartItemId) && match.addressId === body.addressId,
    );
    if (matches.length === 0) return c.json({ error: 'no_products_selected' }, 400);

    // Load the current Instamart cart so preserve/replace is deliberate (AC#4).
    let currentItems: ProviderCartItem[] = [];
    try {
      const current = await provider.getCart(principal.userId, body.addressId);
      if (current) currentItems = current.items;
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }

    const intendedItems = matches.map((m) => ({
      productId: m.productId,
      skuId: m.product.skuId,
      quantity: m.quantity,
    }));
    const plan = buildCartUpdatePlan({ currentItems, intendedItems, mode });

    try {
      const review = await provider.updateCart({
        memberUserId: principal.userId,
        addressId: body.addressId,
        items: plan.items,
      });
      return c.json({
        review: serializeCartReview(review),
        mode,
        preservedCount: plan.preservedCount,
        replacedCount: plan.replacedCount,
      });
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }
  });

  /**
   * AC#6 — the final cart review: every item, quantity, bill breakdown,
   * address, store count, and only payment methods returned by the provider.
   */
  app.get('/v1/households/:householdId/grocery-provider/cart', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const addressId = c.req.query('addressId') ?? '';
    if (!addressId) return c.json({ error: 'address_id_required' }, 400);
    try {
      const review = await provider.getCart(principal.userId, addressId);
      if (!review) return c.json({ review: null });
      const validation = validateCartReview(review);
      return c.json({ review: serializeCartReview(review), valid: validation.valid });
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }
  });

  /** Clear a Member's synchronized Instamart cart after explicit action. */
  app.post('/v1/households/:householdId/grocery-provider/cart/clear', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const body: { addressId?: string } = await c.req.json().catch(() => ({}));
    if (!body.addressId) return c.json({ error: 'address_id_required' }, 400);
    try {
      await provider.clearCart(principal.userId, body.addressId);
      return c.json({ cleared: true });
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code, message: err.message }, providerErrorStatus(err));
      throw err;
    }
  });
}

/** Serialize a provider cart review for the API (issue 10, AC#6). */
export function serializeCartReview(review: ProviderCartReview) {
  return {
    addressId: review.addressId,
    items: review.items,
    bill: review.bill,
    totalCents: review.totalCents,
    availablePaymentMethods: review.availablePaymentMethods,
    storeCount: review.storeCount,
    hasUnavailableItems: review.hasUnavailableItems,
  };
}
