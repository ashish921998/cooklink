/**
 * Cooklink Checkout API routes (issue 11).
 *
 * Two steps, never fewer: (1) `checkout/confirm` snapshots the canonical
 * cart — address, provider-returned payment method, store count, total — and
 * issues a short-lived single-use confirmation token; (2) `checkout` consumes
 * that fresh token plus a role check to actually place the order. A unique
 * idempotency key plus an append-only audit trail prevent blind duplicate
 * submission. After a network/server uncertainty, order history is verified
 * via `get_orders` before any retry is considered. Ineligible carts (over
 * limit, no payment method, ordering disabled) fall back to the Instamart
 * app — Cooklink never cancels or charges on the member's behalf.
 */
import type { Hono } from 'hono';
import {
  auditResultFor,
  brandId,
  buildCheckoutConfirmation,
  cartSignature,
  checkoutIdempotencyKey,
  cancellationGuidance,
  classifyCheckoutResult,
  confirmationMatches,
  decideCheckout,
  shouldRetryCheckout,
  validateCartReview,
  ProviderError,
  type CheckoutConfirmation,
  type ProviderCartReview,
  type ProviderOrder,
} from '@cooklink/domain';
import { DrizzleRepository } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { providerErrorStatus } from './grocery-provider.routes.js';
import { serializeCartReview } from './grocery-cart.routes.js';
import type { AppRouteContext } from './route-context.js';

/** Mount the two-step checkout routes: confirm, place, orders, audit trail. */
export function registerGroceryCheckoutRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization, provider, confirmations, orderingEnabled } = ctx;

  /**
   * Issue 11, AC#1 / AC#9 — the canonical checkout confirmation snapshot.
   *
   * Cooklink shows the canonical cart, address, selected returned payment
   * method, store count, and total immediately before asking for confirmation.
   * The Member explicitly selects a returned payment method (AC#1 — only
   * provider-returned methods) and the server issues a short-lived
   * confirmation token. Checkout never runs without a fresh token (AC#2).
   *
   * When real ordering is disabled by the feature gate (AC#9), the snapshot
   * still renders but carries `orderingEnabled: false` so the Member sees the
   * order is not yet placeable.
   */
  app.post('/v1/households/:householdId/grocery-provider/checkout/confirm', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const body: { addressId?: string; paymentMethodId?: string } = await c.req
      .json()
      .catch(() => ({}));
    if (!body.addressId) return c.json({ error: 'address_id_required' }, 400);

    let review: ProviderCartReview;
    try {
      const fetched = await provider.getCart(principal.userId, body.addressId);
      if (!fetched) return c.json({ error: 'cart_empty' }, 400);
      review = fetched;
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }

    const validation = validateCartReview(review);
    if (!validation.valid)
      return c.json({ error: 'review_incomplete', missing: validation.missing }, 400);

    // AC#1 — only a payment method returned by the provider may be selected.
    const methodIds = review.availablePaymentMethods.map((m) => m.id);
    if (!body.paymentMethodId || !methodIds.includes(body.paymentMethodId)) {
      return c.json({ error: 'payment_method_not_returned' }, 400);
    }

    const token = `cf-${crypto.randomUUID()}`;
    const confirmation = buildCheckoutConfirmation({
      token,
      householdId: principal.householdId,
      membershipId: principal.membershipId,
      review,
      paymentMethodId: body.paymentMethodId,
      now: new Date(),
    });
    confirmations.issue(confirmation);

    const decision = decideCheckout(review.totalCents, methodIds, orderingEnabled);
    return c.json({
      confirmation: serializeConfirmation(confirmation),
      review: serializeCartReview(review),
      eligibility: decision,
      orderingEnabled,
    });
  });

  /**
   * Issue 11, AC#2 / AC#3 / AC#5 / AC#6 / AC#7 — confirm and place the order.
   *
   * Checkout never runs without a fresh explicit Member confirmation token
   * AND a server-side Household Role check (AC#2). Eligible carts below ₹1,000
   * use MCP checkout; carts at/above ₹1,000 or without a returned payment
   * method use the Instamart-app fallback (AC#3, AC#4). A unique checkout
   * attempt + append-only audit trail prevent blind duplicate submission
   * (AC#5). After a network/server uncertainty, order history is checked via
   * `get_orders` before any retry is considered (AC#6). Multi-store partial
   * success is reported per resulting order (AC#7).
   */
  app.post('/v1/households/:householdId/grocery-provider/checkout', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const body: { confirmationToken?: string } = await c.req.json().catch(() => ({}));

    const repo = new DrizzleRepository(db);

    // AC#2 — a fresh, explicit Member confirmation token is required. Consuming
    // the token makes it single-use so it cannot be replayed.
    const confirmation = body.confirmationToken
      ? confirmations.consume(body.confirmationToken)
      : null;
    if (!confirmation) {
      return c.json({ error: 'fresh_confirmation_required' }, 400);
    }

    // AC#2 — the confirmation must be bound to the acting membership. This is
    // a second line of defense behind the capability check.
    if (confirmation.membershipId !== principal.membershipId) {
      return c.json({ error: 'confirmation_membership_mismatch' }, 403);
    }

    // Fetch the live cart to re-validate the confirmation against it.
    let review: ProviderCartReview;
    try {
      const fetched = await provider.getCart(principal.userId, confirmation.addressId);
      if (!fetched) return c.json({ error: 'cart_empty' }, 400);
      review = fetched;
    } catch (err) {
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }

    const match = confirmationMatches(
      confirmation,
      {
        membershipId: principal.membershipId,
        review,
        paymentMethodId: confirmation.paymentMethodId,
      },
      new Date(),
    );
    if (!match.valid) {
      await repo.appendCheckoutAudit({
        idempotencyKey: 'n/a',
        membershipId: principal.membershipId,
        householdId: principal.householdId,
        cartTotalCents: review.totalCents,
        paymentMethod: confirmation.paymentMethodId,
        result: auditResultFor({
          placed: false,
          partialSuccess: false,
          fallback: false,
          recoveredAlreadyPlaced: false,
          denied: 'stale_confirmation',
        }),
        verifiedViaGetOrders: false,
      });
      return c.json({ error: 'confirmation_invalid', reason: match.reason }, 409);
    }

    const methodIds = review.availablePaymentMethods.map((m) => m.id);
    const decision = decideCheckout(review.totalCents, methodIds, orderingEnabled);

    // AC#9 — real ordering is visibly feature-gated.
    if (decision.reason === 'disabled') {
      await repo.appendCheckoutAudit({
        idempotencyKey: 'n/a',
        membershipId: principal.membershipId,
        householdId: principal.householdId,
        cartTotalCents: review.totalCents,
        paymentMethod: confirmation.paymentMethodId,
        result: auditResultFor({
          placed: false,
          partialSuccess: false,
          fallback: false,
          recoveredAlreadyPlaced: false,
          denied: 'disabled',
        }),
        verifiedViaGetOrders: false,
      });
      return c.json({ error: 'ordering_disabled' }, 403);
    }

    // Instamart documents a ₹99 minimum. Keep the Member in cart review so
    // they can add an item; this is not an app handoff or a retryable failure.
    if (decision.reason === 'min_order_not_met') {
      await repo.appendCheckoutAudit({
        idempotencyKey: 'n/a',
        membershipId: principal.membershipId,
        householdId: principal.householdId,
        cartTotalCents: review.totalCents,
        paymentMethod: confirmation.paymentMethodId,
        result: 'failed',
        verifiedViaGetOrders: false,
      });
      return c.json(
        {
          error: 'minimum_order_not_met',
          minimumCents: 9_900,
          totalCents: review.totalCents,
        },
        409,
      );
    }

    // AC#3 / AC#4 — ineligible carts (over limit or no payment method) fall
    // back to the Instamart app. The fallback relies on the synchronized cart
    // state (already pushed via update_cart) but does NOT promise a direct
    // deep link to the cart (issue 11, AC#4).
    if (!decision.eligible) {
      await repo.appendCheckoutAudit({
        idempotencyKey: 'n/a',
        membershipId: principal.membershipId,
        householdId: principal.householdId,
        cartTotalCents: review.totalCents,
        paymentMethod: confirmation.paymentMethodId,
        result: auditResultFor({
          placed: false,
          partialSuccess: false,
          fallback: true,
          recoveredAlreadyPlaced: false,
          denied: null,
        }),
        verifiedViaGetOrders: false,
      });
      return c.json({
        result: 'fallback_instamart_app',
        reason: decision.reason,
        addressId: review.addressId,
        // No deep link — the cart is synced; the member opens Instamart to pay.
        deepLink: null,
      });
    }

    // AC#5 — a unique checkout attempt keyed by an idempotency key prevents a
    // blind duplicate submission. The key is derived from the membership and
    // the cart signature so the same cart retried reuses the same attempt.
    const sig = cartSignature(
      review.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );
    const idempotencyKey = checkoutIdempotencyKey(principal.membershipId as string, sig);

    const existing = await repo.getIdempotencyKey(idempotencyKey);
    if (existing) {
      return c.json({
        result: 'already_attempted',
        status: existing.status,
        attempt: existing,
      });
    }

    let preCheckoutOrderIds: Set<string> | null = null;
    try {
      preCheckoutOrderIds = new Set(
        (await provider.getOrders(principal.userId)).map((order) => order.id),
      );
    } catch {
      // Recovery must fail closed if we cannot establish the pre-checkout
      // baseline. A later history response alone cannot prove which attempt
      // created an order.
    }
    const checkoutStartedAt = Date.now();

    await repo.beginIdempotencyKey({
      key: idempotencyKey,
      membershipId: principal.membershipId,
      householdId: principal.householdId,
    });

    // AC#6 — place the order. On a network/server uncertainty
    // (upstream_error), consult get_orders before any retry is considered.
    try {
      const checkout = await provider.placeOrder({
        memberUserId: principal.userId,
        addressId: review.addressId,
        paymentMethodId: confirmation.paymentMethodId!,
        idempotencyKey,
      });

      const classified = classifyCheckoutResult(checkout.orders);

      // Persist one Cooklink GroceryOrder per resulting provider order (AC#7 —
      // multi-store partial success shown per order, not as one misleading row).
      for (const order of checkout.orders) {
        await repo.createOrder(principal.householdId, principal.membershipId, {
          providerOrderId: order.id,
          status: order.status === 'failed' ? 'failed' : 'placed',
          totalCents: order.totalCents,
        });
      }

      await repo.completeIdempotencyKey(idempotencyKey, 'succeeded', {
        orders: checkout.orders.map((o) => o.id),
        partialSuccess: classified.partialSuccess,
      });
      await repo.appendCheckoutAudit({
        idempotencyKey,
        membershipId: principal.membershipId,
        householdId: principal.householdId,
        cartTotalCents: review.totalCents,
        paymentMethod: confirmation.paymentMethodId,
        result: auditResultFor({
          placed: true,
          partialSuccess: classified.partialSuccess,
          fallback: false,
          recoveredAlreadyPlaced: false,
          denied: null,
        }),
        verifiedViaGetOrders: false,
      });

      return c.json({
        result: classified.partialSuccess ? 'partial_success' : 'succeeded',
        orders: checkout.orders.map((o) => serializeProviderOrder(o)),
        allSucceeded: classified.allSucceeded,
        partialSuccess: classified.partialSuccess,
      });
    } catch (err) {
      // AC#6 — after a network/server uncertainty, check order history before
      // any retry is considered. If get_orders proves an order was already
      // placed, NEVER retry.
      if (err instanceof ProviderError && err.code === 'upstream_error') {
        let providerOrders: ProviderOrder[] = [];
        try {
          providerOrders = await provider.getOrders(principal.userId);
        } catch {
          providerOrders = [];
        }
        const recoveredOrders = preCheckoutOrderIds
          ? providerOrders.filter((order) => {
              const placedAt = Date.parse(order.placedAt);
              return (
                !preCheckoutOrderIds!.has(order.id) &&
                Number.isFinite(placedAt) &&
                placedAt >= checkoutStartedAt - 60_000 &&
                order.status !== 'failed'
              );
            })
          : [];
        const alreadyPlaced = recoveredOrders.length > 0;
        const retry = shouldRetryCheckout({
          uncertainFailure: true,
          orderAlreadyPlaced: alreadyPlaced,
        });
        await repo.completeIdempotencyKey(idempotencyKey, alreadyPlaced ? 'succeeded' : 'failed', {
          uncertain: true,
          alreadyPlaced,
          retry,
        });
        await repo.appendCheckoutAudit({
          idempotencyKey,
          membershipId: principal.membershipId,
          householdId: principal.householdId,
          cartTotalCents: review.totalCents,
          paymentMethod: confirmation.paymentMethodId,
          result: alreadyPlaced ? 'recovered_order_already_placed' : 'failed',
          verifiedViaGetOrders: true,
        });

        if (alreadyPlaced) {
          // Reconcile Cooklink order rows from the verified provider orders.
          for (const order of recoveredOrders) {
            await repo.createOrder(principal.householdId, principal.membershipId, {
              providerOrderId: order.id,
              status: order.status === 'failed' ? 'failed' : 'placed',
              totalCents: order.totalCents,
            });
          }
          return c.json({
            result: 'recovered_order_already_placed',
            orders: recoveredOrders.map((o) => serializeProviderOrder(o)),
            retry: false,
          });
        }
        return c.json(
          { result: 'checkout_uncertain', retry, error: err.code },
          providerErrorStatus(err),
        );
      }

      await repo.completeIdempotencyKey(idempotencyKey, 'failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      await repo.appendCheckoutAudit({
        idempotencyKey,
        membershipId: principal.membershipId,
        householdId: principal.householdId,
        cartTotalCents: review.totalCents,
        paymentMethod: confirmation.paymentMethodId,
        result: 'failed',
        verifiedViaGetOrders: false,
      });
      if (err instanceof ProviderError)
        return c.json({ error: err.code }, providerErrorStatus(err));
      throw err;
    }
  });

  /**
   * Issue 11, AC#8 — recent order state and tracking, with cancellation
   * guidance that follows the provider contract.
   *
   * Members view recent orders with live provider status, tracking URL, ETA,
   * and cancellation guidance. Cooklink never cancels on the member's behalf;
   * it surfaces whether the order is still cancellable and the provider's
   * policy text.
   */
  app.get('/v1/households/:householdId/grocery-provider/orders', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const repo = new DrizzleRepository(db);
    const localOrders = await repo.listOrders(principal.householdId);

    // Reconcile with live provider order state + tracking (AC#8).
    let providerOrders: ProviderOrder[] = [];
    try {
      providerOrders = await provider.getOrders(principal.userId);
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.code }, providerErrorStatus(err));
      }
      throw err;
    }
    const providerById = new Map(providerOrders.map((o) => [o.id, o]));
    const now = new Date();

    const orders = localOrders
      .map((local) => {
        const live = local.providerOrderId
          ? (providerById.get(local.providerOrderId) ?? null)
          : null;
        const effective = live ?? null;
        return {
          id: local.id,
          providerOrderId: local.providerOrderId,
          localStatus: local.status,
          providerStatus: effective?.status ?? null,
          totalCents: local.totalCents,
          createdAt: local.createdAt,
          tracking: effective
            ? {
                trackingUrl: effective.trackingUrl,
                deliveryEta: effective.deliveryEta,
                storeName: effective.storeName,
                storeCount: effective.items.length > 0 ? effective.items.length : 1,
              }
            : null,
          cancellation: effective ? cancellationGuidance(effective, now) : null,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return c.json({ orders });
  });

  /**
   * Issue 11, AC#5 — the append-only checkout audit trail for a Household.
   * Every checkout attempt, success, failure, fallback, and recovery is
   * recorded exactly once and never updated or deleted.
   */
  app.get('/v1/households/:householdId/grocery-provider/checkout/audit', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'review_place_order',
    );
    const repo = new DrizzleRepository(db);
    const audit = await repo.listCheckoutAudit(principal.householdId);
    return c.json({
      audit: audit.map((row) => ({
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        result: row.result,
        paymentMethod: row.paymentMethod,
        cartTotalCents: row.cartTotalCents,
        verifiedViaGetOrders: row.verifiedViaGetOrders,
        createdAt: row.createdAt,
      })),
    });
  });
}

/** Serialize a checkout confirmation snapshot for the API (issue 11, AC#1). */
export function serializeConfirmation(confirmation: CheckoutConfirmation) {
  return {
    token: confirmation.token,
    addressId: confirmation.addressId,
    paymentMethodId: confirmation.paymentMethodId,
    storeCount: confirmation.storeCount,
    totalCents: confirmation.totalCents,
    itemCount: confirmation.itemCount,
    issuedAt: confirmation.issuedAt,
    expiresAt: confirmation.expiresAt,
  };
}

/** Serialize a provider order for the API (issue 11, AC#7 / AC#8). */
export function serializeProviderOrder(order: ProviderOrder) {
  return {
    id: order.id,
    status: order.status,
    storeId: order.storeId,
    storeName: order.storeName,
    totalCents: order.totalCents,
    items: order.items,
    placedAt: order.placedAt,
    deliveryEta: order.deliveryEta,
    trackingUrl: order.trackingUrl,
    cancellableUntil: order.cancellableUntil,
    cancellationPolicy: order.cancellationPolicy,
  };
}
