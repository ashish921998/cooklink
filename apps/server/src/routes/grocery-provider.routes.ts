/**
 * Grocery provider API routes (issue 10 — match needs to exact Instamart
 * products): Swiggy account connection (delegated OAuth + browser callback),
 * addresses, product search, product matching for Suggested Grocery Cart
 * lines, the full match plan, and unavailable-product alternatives.
 *
 * Cooks never see connection or cart controls (AC#1). Every route below
 * requires a Member/Owner capability (`review_place_order` or `add_to_cart`);
 * a Cook gets a 404 (authorization-denied is logged and returned as 404 so
 * roles cannot be probed).
 */
import type { Hono } from 'hono';
import {
  brandId,
  allResolved,
  orderableCartItems,
  refreshSuggestedCart,
  resolveMatchPlan,
  searchQueryFor,
  todayISO,
  ProviderError,
  type ProductMatch,
  type ProviderProduct,
} from '@cooklink/domain';
import { DrizzleRepository, suggestedCartItems } from '@cooklink/db';
import { and, eq } from 'drizzle-orm';
import type { AuthEnv } from '../auth.js';
import { serializeSuggestedCartItem, toDomainCartItem } from './suggested-cart.routes.js';
import type { AppRouteContext } from './route-context.js';

/** Mount the Swiggy provider routes: OAuth, addresses, search, matching, alternatives. */
export function registerGroceryProviderRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization, provider, log, swiggyOAuthCallbacks } = ctx;

  /**
   * Browser-facing OAuth callback. Swiggy accepts localhost/HTTPS callbacks,
   * not arbitrary app schemes, so the server exchanges the code and then
   * returns the member to Cooklink without exposing the authorization code to
   * the mobile app. The callback record is consumed atomically (single-use,
   * TTL-enforced in the durable store), so a replayed or concurrent callback
   * fails closed.
   */
  app.get('/oauth/swiggy/callback', async (c) => {
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    const oauthError = c.req.query('error') ?? '';
    const pending = await swiggyOAuthCallbacks.consume(state);
    if (!pending) {
      return c.text(
        'This Cooklink Swiggy sign-in has expired. Return to Cooklink and try again.',
        400,
      );
    }
    const returnUrl = new URL(pending.appReturnUri);
    if (oauthError || !code) {
      returnUrl.searchParams.set('error', oauthError || 'authorization_failed');
      return c.redirect(returnUrl.toString());
    }
    try {
      await provider.completeOAuth({ memberUserId: pending.userId, code, state });
      returnUrl.searchParams.set('connected', '1');
      return c.redirect(returnUrl.toString());
    } catch (error) {
      log.warn({ msg: 'swiggy.oauth_callback_failed', error });
      returnUrl.searchParams.set('error', 'token_exchange_failed');
      return c.redirect(returnUrl.toString());
    }
  });

  /**
   * AC#1 — a Member connects their own Swiggy account through delegated OAuth.
   * Cooklink never receives the password or OTP. The mobile app opens the
   * returned authorization URL in a browser; Swiggy redirects back to the
   * `redirectUri` with a code that `complete` exchanges.
   */
  app.post('/v1/households/:householdId/grocery-provider/connect', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const body: { redirectUri?: string; appReturnUri?: string } = await c.req
      .json()
      .catch(() => ({}));
    const appReturnUri = body.appReturnUri ?? '';
    if (appReturnUri && !isCooklinkReturnUri(appReturnUri)) {
      return c.json({ error: 'invalid_app_return_uri' }, 400);
    }
    const publicApiUrl = process.env.COOKLINK_PUBLIC_API_URL ?? new URL(c.req.url).origin;
    const redirectUri = appReturnUri
      ? new URL('/oauth/swiggy/callback', publicApiUrl).toString()
      : (body.redirectUri ?? '');
    if (!redirectUri) return c.json({ error: 'redirect_uri_required' }, 400);
    try {
      const result = await provider.startOAuth({
        memberUserId: principal.userId,
        redirectUri,
      });
      if (appReturnUri) {
        await swiggyOAuthCallbacks.save(
          result.state,
          {
            userId: principal.userId,
            appReturnUri,
          },
          10 * 60_000,
        );
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code, message: err.message }, providerErrorStatus(err));
      throw err;
    }
  });

  /** Complete the delegated OAuth callback (AC#1). */
  app.post('/v1/households/:householdId/grocery-provider/complete', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const body: { code?: string; state?: string } = await c.req.json().catch(() => ({}));
    if (!body.code || !body.state) return c.json({ error: 'code_and_state_required' }, 400);
    try {
      const result = await provider.completeOAuth({
        memberUserId: principal.userId,
        code: body.code,
        state: body.state,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code, message: err.message }, providerErrorStatus(err));
      throw err;
    }
  });

  /** AC#1 — connection status. Cooks get 404; only Members/Owners see this. */
  app.get('/v1/households/:householdId/grocery-provider/status', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    try {
      const status = await provider.getConnectionStatus(principal.userId);
      return c.json(status);
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code, message: err.message }, providerErrorStatus(err));
      throw err;
    }
  });

  /** Disconnect the member's Swiggy account (AC#1). */
  app.post('/v1/households/:householdId/grocery-provider/disconnect', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    await provider.disconnect(principal.userId);
    return c.json({ connected: false });
  });

  /**
   * AC#2 — the member's saved Instamart delivery addresses. Product search is
   * scoped to the selected address.
   */
  app.get('/v1/households/:householdId/grocery-provider/addresses', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    try {
      const addresses = await provider.getAddresses(principal.userId);
      return c.json({ addresses });
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }
  });

  /**
   * AC#2 — search products scoped to `addressId`. Presents exact brand,
   * variant, pack size, price, and availability. A vague grocery need yields
   * candidates but stays unresolved until the Member chooses one (AC#3).
   */
  app.get('/v1/households/:householdId/grocery-provider/search', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const addressId = c.req.query('addressId') ?? '';
    const q = (c.req.query('q') ?? '').trim();
    if (!addressId) return c.json({ error: 'address_id_required' }, 400);
    if (!q) return c.json({ products: [] });
    try {
      const products = await provider.searchProducts({
        memberUserId: principal.userId,
        addressId,
        query: q,
      });
      return c.json({ products });
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }
  });

  /**
   * AC#3 — a Member chooses an exact product for one Suggested Grocery Cart
   * line. The need stays unresolved until this is done. The product snapshot
   * is persisted so the review shows the exact brand/variant/pack/price at
   * selection time.
   */
  app.post('/v1/households/:householdId/grocery-provider/match', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'add_to_cart',
    );
    const body: {
      cartItemId?: string;
      productId?: string;
      addressId?: string;
      quantity?: number;
    } = await c.req.json().catch(() => ({}));
    if (!body.cartItemId || !body.productId || !body.addressId) {
      return c.json({ error: 'cart_item_id_product_id_address_id_required' }, 400);
    }
    const quantity = body.quantity && body.quantity > 0 ? Math.floor(body.quantity) : 1;

    // Verify the cart item belongs to this household.
    const [cartRow] = await db
      .select()
      .from(suggestedCartItems)
      .where(
        and(
          eq(suggestedCartItems.id, body.cartItemId),
          eq(suggestedCartItems.householdId, principal.householdId),
        ),
      )
      .limit(1);
    if (!cartRow) return c.json({ error: 'cart_item_not_found' }, 404);
    if (cartRow.memberState !== 'kept') {
      return c.json({ error: 'cart_item_not_approved' }, 409);
    }

    // Fetch the product from the provider to persist an exact snapshot.
    let product: ProviderProduct;
    try {
      const results = await provider.searchProducts({
        memberUserId: principal.userId,
        addressId: body.addressId,
        query: searchQueryFor(toDomainCartItem(cartRow)),
      });
      const found = results.find((p) => p.id === body.productId);
      if (!found) return c.json({ error: 'product_not_found' }, 404);
      product = found;
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }

    const match: ProductMatch = {
      id: crypto.randomUUID(),
      householdId: principal.householdId,
      cartItemId: body.cartItemId,
      productId: body.productId,
      addressId: body.addressId,
      quantity,
      product,
      selectedById: principal.membershipId,
      selectedAt: new Date().toISOString(),
    };
    const repo = new DrizzleRepository(db);
    await repo.upsertProductMatch(match);
    return c.json({ match: serializeProductMatch(match) });
  });

  /**
   * AC#3 — the full match plan for the current Suggested Grocery Cart. Each
   * line is `resolved`, `unresolved`, or `unavailable` (AC#5). Cooklink never
   * silently picks a brand or pack size.
   */
  app.get('/v1/households/:householdId/grocery-provider/match-plan', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'add_to_cart',
    );
    const addressId = c.req.query('addressId') ?? '';
    const repo = new DrizzleRepository(db);
    const refreshedCartItems = await refreshSuggestedCart(
      repo,
      principal.householdId,
      todayISO(),
      new Date(),
    );
    const cartItems = orderableCartItems(refreshedCartItems);
    const keptIds = new Set(cartItems.map((item) => item.id));
    const matches = (await repo.getProductMatches(principal.householdId)).filter(
      (match) => keptIds.has(match.cartItemId) && (!addressId || match.addressId === addressId),
    );
    // Search products for unresolved cart lines so the client gets candidates.
    const searchResults = new Map<string, ProviderProduct[]>();
    if (addressId) {
      for (const item of cartItems) {
        const query = searchQueryFor(item);
        if (!query) continue;
        try {
          const products = await provider.searchProducts({
            memberUserId: principal.userId,
            addressId,
            query,
          });
          searchResults.set(item.id, products);
        } catch {
          // Provider not connected or error — leave candidates empty.
        }
      }
    }
    const plan = resolveMatchPlan({ cartItems, matches, searchResults });
    return c.json({ plan: plan.map(serializeMatchResolution), allResolved: allResolved(plan) });
  });

  /** Remove a product match (the need becomes unresolved again). */
  app.delete('/v1/households/:householdId/grocery-provider/match/:cartItemId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'add_to_cart',
    );
    const repo = new DrizzleRepository(db);
    await repo.clearProductMatch(principal.householdId, c.req.param('cartItemId'));
    return c.json({ ok: true });
  });

  /**
   * AC#5 — if a selected product became unavailable, Cooklink offers up to
   * three exact available alternatives and requires deliberate replacement or
   * removal.
   */
  app.get('/v1/households/:householdId/grocery-provider/alternatives', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'add_to_cart',
    );
    const addressId = c.req.query('addressId') ?? '';
    const productId = c.req.query('productId') ?? '';
    if (!addressId || !productId) {
      return c.json({ error: 'address_id_and_product_id_required' }, 400);
    }
    try {
      const alternatives = await provider.getAlternatives({
        memberUserId: principal.userId,
        addressId,
        productId,
      });
      return c.json({ alternatives });
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }
  });
}

/** Map a ProviderError code to an HTTP status (issue 10, AC#7). */
export function providerErrorStatus(err: ProviderError): 400 | 401 | 404 | 429 | 502 {
  switch (err.code) {
    case 'not_connected':
    case 'expired_session':
      return 401;
    case 'address_not_found':
    case 'product_not_found':
      return 404;
    case 'rate_limited':
      return 429;
    case 'upstream_error':
      return 502;
    default:
      return 400;
  }
}

/** True when the URI is a Cooklink app deep link (`cooklink:` scheme). */
export function isCooklinkReturnUri(value: string): boolean {
  try {
    return new URL(value).protocol === 'cooklink:';
  } catch {
    return false;
  }
}

/** Serialize a ProductMatch for the API (issue 10, AC#3). */
export function serializeProductMatch(match: ProductMatch) {
  return {
    id: match.id,
    cartItemId: match.cartItemId,
    productId: match.productId,
    addressId: match.addressId,
    quantity: match.quantity,
    product: match.product,
    selectedById: match.selectedById as string,
    selectedAt: match.selectedAt,
  };
}

/** Serialize a match-plan resolution (issue 10, AC#3 / AC#5). */
export function serializeMatchResolution(res: ReturnType<typeof resolveMatchPlan>[number]) {
  if (res.state === 'unresolved') {
    return {
      state: 'unresolved' as const,
      cartItem: serializeSuggestedCartItem(res.cartItem),
      candidates: res.candidates,
    };
  }
  if (res.state === 'unavailable') {
    return {
      state: 'unavailable' as const,
      cartItem: serializeSuggestedCartItem(res.cartItem),
      match: serializeProductMatch(res.match),
      alternatives: res.alternatives,
    };
  }
  return {
    state: 'resolved' as const,
    cartItem: serializeSuggestedCartItem(res.cartItem),
    match: serializeProductMatch(res.match),
  };
}
