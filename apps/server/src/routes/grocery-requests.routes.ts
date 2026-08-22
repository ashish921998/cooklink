/**
 * Grocery Request API routes (ticket 08).
 *
 * A Grocery Request is a missing ingredient described naturally by a Cook for
 * Member review. Cooks edit or cancel their own pending requests; Members
 * approve, reject, or "order now" (approve into the next Suggested Grocery
 * Cart review). No resolution ever places an order — exact product matching,
 * cart review, and fresh checkout confirmation stay in Groceries (AC#8). All
 * mutations are optimistic-concurrency guarded and attributed in Household
 * Chat; a stale edit returns the current state plus the actor who changed it.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import {
  assertNoOrderPlacement,
  brandId,
  decideRequestResolution,
  decideRequestUpdate,
  type GroceryRequest,
  type GroceryRequestStatus,
} from '@cooklink/domain';
import { groceryRequests, systemEvents } from '@cooklink/db';
import type { Database } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { resolveMembershipLabels } from './chat.routes.js';
import type { AppRouteContext } from './route-context.js';

/** Mount the grocery-request routes: list, Cook edit/cancel, Member resolve. */
export function registerGroceryRequestRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization } = ctx;

  /**
   * List Grocery Requests in the Household. All active participants may read;
   * Cooks receive the request status they need, Members see the pending queue
   * for approval. The response never includes money (issue 06, AC#24).
   */
  app.get('/v1/households/:householdId/grocery-requests', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const statusParam = c.req.query('status') as GroceryRequestStatus | undefined;
    const rows = await db
      .select()
      .from(groceryRequests)
      .where(
        statusParam
          ? and(
              eq(groceryRequests.householdId, principal.householdId),
              eq(groceryRequests.status, statusParam),
            )
          : eq(groceryRequests.householdId, principal.householdId),
      )
      .orderBy(desc(groceryRequests.createdAt));
    return c.json({
      requests: rows.map((r) => serializeGroceryRequest(toDomainGroceryRequest(r))),
    });
  });

  /**
   * A Cook updates item/quantity or cancels a pending Grocery Request (AC#6).
   * Either active Cook may act; the capability is `edit_cancel_pending_request`.
   * After Member approval the request is locked and the Cook must ask a Member
   * to act. Optimistic concurrency: a stale Cook edit returns the current
   * state with the actor who changed it for fresh confirmation.
   */
  app.patch('/v1/households/:householdId/grocery-requests/:requestId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_cancel_pending_request',
    );
    const requestId = c.req.param('requestId');
    const body: {
      expectedVersion?: number;
      itemText?: string;
      quantityText?: string | null;
      status?: 'cancelled';
    } = await c.req.json().catch(() => ({}));
    if (body.expectedVersion === undefined || !Number.isFinite(body.expectedVersion)) {
      return c.json({ error: 'expected_version_required' }, 400);
    }
    const [current] = await db
      .select()
      .from(groceryRequests)
      .where(
        and(
          eq(groceryRequests.id, requestId),
          eq(groceryRequests.householdId, principal.householdId),
        ),
      )
      .limit(1);
    if (!current) return c.json({ error: 'not_found' }, 404);

    const decision = decideRequestUpdate({
      current: toDomainGroceryRequest(current),
      expectedVersion: body.expectedVersion,
      patch: {
        itemText: body.itemText,
        quantityText: body.quantityText,
        status: body.status,
      },
      now: new Date(),
    });
    if (!decision.ok) {
      const [fresh] = await db
        .select()
        .from(groceryRequests)
        .where(eq(groceryRequests.id, requestId))
        .limit(1);
      const actor = fresh ? await latestRequestActor(db, principal.householdId, requestId) : null;
      return c.json(
        {
          error: decision.reason,
          current: fresh ? serializeGroceryRequest(toDomainGroceryRequest(fresh)) : null,
          changedBy: actor,
        },
        decision.reason === 'locked_after_approval' ? 422 : 409,
      );
    }

    const eventType =
      decision.next.status === 'cancelled'
        ? 'grocery_request.cancelled'
        : 'grocery_request.updated';
    const [updated] = await db.transaction(async (tx) => {
      await tx
        .update(groceryRequests)
        .set({
          itemText: decision.next.itemText,
          quantityText: decision.next.quantityText,
          status: decision.next.status,
          version: decision.next.version,
        })
        .where(eq(groceryRequests.id, requestId));
      await tx.insert(systemEvents).values({
        id: randomUUID(),
        householdId: principal.householdId,
        type: eventType,
        actorId: principal.membershipId,
        entityType: 'grocery_request',
        entityId: requestId,
        payload: {
          item: decision.next.itemText,
          quantity: decision.next.quantityText,
          status: decision.next.status,
        },
      });
      const [row] = await tx
        .select()
        .from(groceryRequests)
        .where(eq(groceryRequests.id, requestId))
        .limit(1);
      return [row];
    });
    return c.json({ request: serializeGroceryRequest(toDomainGroceryRequest(updated!)) });
  });

  /**
   * A Household Member resolves a pending Grocery Request: approve, reject, or
   * "order now" (approve for the next Suggested Grocery Cart review). The
   * capability is `approve_reject_request`; Cooks cannot resolve. Neither
   * approval nor "order now" places an order — exact product matching, cart
   * review, and fresh checkout confirmation remain in Groceries (AC#8).
   */
  app.post('/v1/households/:householdId/grocery-requests/:requestId/resolve', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'approve_reject_request',
    );
    const requestId = c.req.param('requestId');
    const body: { expectedVersion?: number; resolution?: 'approve' | 'reject' | 'order_now' } =
      await c.req.json().catch(() => ({}));
    if (
      body.expectedVersion === undefined ||
      !Number.isFinite(body.expectedVersion) ||
      !body.resolution
    ) {
      return c.json({ error: 'expected_version_and_resolution_required' }, 400);
    }
    const [current] = await db
      .select()
      .from(groceryRequests)
      .where(
        and(
          eq(groceryRequests.id, requestId),
          eq(groceryRequests.householdId, principal.householdId),
        ),
      )
      .limit(1);
    if (!current) return c.json({ error: 'not_found' }, 404);

    const decision = decideRequestResolution({
      current: toDomainGroceryRequest(current),
      expectedVersion: body.expectedVersion,
      resolution: body.resolution,
    });
    if (!decision.ok) {
      const [fresh] = await db
        .select()
        .from(groceryRequests)
        .where(eq(groceryRequests.id, requestId))
        .limit(1);
      const actor = fresh ? await latestRequestActor(db, principal.householdId, requestId) : null;
      return c.json(
        {
          error: decision.reason,
          current: fresh ? serializeGroceryRequest(toDomainGroceryRequest(fresh)) : null,
          changedBy: actor,
        },
        409,
      );
    }
    // Guard by construction: a resolution never places an order (AC#8).
    assertNoOrderPlacement(decision);

    const eventType =
      decision.nextStatus === 'rejected' ? 'grocery_request.rejected' : 'grocery_request.approved';
    const [updated] = await db.transaction(async (tx) => {
      await tx
        .update(groceryRequests)
        .set({
          status: decision.nextStatus,
          resolvedById: principal.membershipId,
          resolvedAt: new Date(),
          version: decision.version,
        })
        .where(eq(groceryRequests.id, requestId));
      await tx.insert(systemEvents).values({
        id: randomUUID(),
        householdId: principal.householdId,
        type: eventType,
        actorId: principal.membershipId,
        entityType: 'grocery_request',
        entityId: requestId,
        payload: {
          item: current.itemText,
          quantity: current.quantityText,
          status: decision.nextStatus,
        },
      });
      const [row] = await tx
        .select()
        .from(groceryRequests)
        .where(eq(groceryRequests.id, requestId))
        .limit(1);
      return [row];
    });
    return c.json({
      request: serializeGroceryRequest(toDomainGroceryRequest(updated!)),
      orderNow: decision.orderNow,
    });
  });
}

/** Map a Drizzle grocery-request row onto the domain `GroceryRequest`. */
export function toDomainGroceryRequest(row: typeof groceryRequests.$inferSelect): GroceryRequest {
  return {
    id: brandId<'GroceryRequestId'>(row.id),
    householdId: brandId<'HouseholdId'>(row.householdId),
    itemText: row.itemText,
    quantityText: row.quantityText,
    status: row.status as GroceryRequest['status'],
    createdById: brandId<'MembershipId'>(row.createdById),
    createdAt: row.createdAt.toISOString(),
    resolvedById: row.resolvedById ? brandId<'MembershipId'>(row.resolvedById) : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    version: row.version,
  };
}

/**
 * Serialize a Grocery Request for the API. A Grocery Request carries no money
 * fields; the related cart/checkout surfaces own amounts (issue 06, AC#24).
 */
export function serializeGroceryRequest(request: GroceryRequest) {
  return {
    id: request.id as string,
    householdId: request.householdId as string,
    itemText: request.itemText,
    quantityText: request.quantityText,
    status: request.status,
    createdById: request.createdById as string,
    createdAt: request.createdAt,
    resolvedById: request.resolvedById ? (request.resolvedById as string) : null,
    resolvedAt: request.resolvedAt,
    version: request.version,
  };
}

/**
 * Resolve the actor who last changed a Grocery Request, so a stale Cook edit
 * or Member resolution can show "Cook B changed this" with the current state
 * for fresh confirmation (ticket 08, AC#6; issue 06 — show the current state
 * and the actor who changed it). Returns null when no event is found.
 */
export async function latestRequestActor(
  db: Database,
  householdId: string,
  requestId: string,
): Promise<{ membershipId: string; displayName: string; role: string } | null> {
  const [event] = await db
    .select()
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.householdId, householdId),
        eq(systemEvents.entityType, 'grocery_request'),
        eq(systemEvents.entityId, requestId),
      ),
    )
    .orderBy(desc(systemEvents.createdAt))
    .limit(1);
  if (!event?.actorId) return null;
  const labels = await resolveMembershipLabels(db, householdId, [event.actorId]);
  const label = labels.get(event.actorId);
  if (!label) return null;
  return { membershipId: event.actorId, displayName: label.displayName, role: label.role };
}
