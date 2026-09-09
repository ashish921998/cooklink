/**
 * Private chat action suggestions (ticket 08).
 *
 * When a chat message carries an actionable intent (grocery need, meal
 * change), Cooklink persists a PRIVATE suggestion for its author. Confirming
 * one performs the role-appropriate structured mutation — a Cook creates a
 * pending Grocery Request; a Member/Owner adds a Suggested Grocery Cart line.
 * Suggestions are visible only to their author, survive app restarts, expire
 * after 24 hours, and never mutate structured state until confirmed.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import {
  brandId,
  decideGrocerySuggestion,
  decideRequestUpdate,
  findSimilarPendingRequest,
  type ActionSuggestion,
  type ChatIntent,
  type Language,
} from '@cooklink/domain';
import {
  actionSuggestions,
  groceryRequests,
  households,
  suggestedCartItems,
  systemEvents,
} from '@cooklink/db';
import type { Database } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { serializeGroceryRequest, toDomainGroceryRequest } from './grocery-requests.routes.js';
import type { AppRouteContext } from './route-context.js';

/** Mount the /v1/households/:id/chat/suggestions routes (confirm, dismiss, list). */
export function registerChatSuggestionRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization } = ctx;

  /**
   * Confirm a private action suggestion authored from a chat message. The
   * server re-authorizes the author, validates the suggestion is still pending
   * and unexpired, and performs the role-appropriate structured mutation:
   *   - Cook → create a pending Grocery Request + attributed Chat event.
   *   - Member/Owner → add a Suggested Grocery Cart item for review.
   *
   * A missing essential detail (no item) returns one plain follow-up question
   * instead of creating a record (AC#2). When a similar pending request
   * exists, the server returns the Update quantity / Keep separate choice
   * rather than emitting a duplicate (AC#5). `keepSeparate: true` forces a
   * new request; `updateQuantity: true` updates the similar request's
   * quantity.
   */
  app.post('/v1/households/:householdId/chat/suggestions/:suggestionId/confirm', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const suggestionId = c.req.param('suggestionId');
    const [suggestionRow] = await db
      .select()
      .from(actionSuggestions)
      .where(eq(actionSuggestions.id, suggestionId))
      .limit(1);
    if (
      !suggestionRow ||
      suggestionRow.householdId !== principal.householdId ||
      suggestionRow.authorId !== principal.membershipId
    ) {
      // A suggestion is private to its author (AC#3); a non-author (even a
      // member of the same Household) gets a generic not-found.
      return c.json({ error: 'not_found' }, 404);
    }

    const body: {
      keepSeparate?: boolean;
      updateQuantity?: boolean;
      quantity?: string | null;
    } = await c.req.json().catch(() => ({}));
    const [householdRow] = await db
      .select()
      .from(households)
      .where(eq(households.id, principal.householdId))
      .limit(1);
    const language: Language = householdRow?.defaultLanguage ?? 'en';
    const intent = suggestionRow.intent as ChatIntent;
    const decision = decideGrocerySuggestion({
      intent,
      role: principal.role,
      language,
      suggestion: {
        status: suggestionRow.status as ActionSuggestion['status'],
        expiresAt: suggestionRow.expiresAt.toISOString(),
      },
      now: new Date(),
    });
    if (!decision.ok) {
      if (decision.reason === 'missing_item') {
        // AC#2 — one plain follow-up question, not a form.
        return c.json({ error: 'missing_item', followUp: decision.followUp }, 422);
      }
      if (decision.reason === 'suggestion_expired') {
        await db
          .update(actionSuggestions)
          .set({ status: 'expired' })
          .where(eq(actionSuggestions.id, suggestionId));
      }
      return c.json({ error: decision.reason }, 409);
    }

    // AC#5 — similarity check at commit for Cook grocery requests.
    if (decision.action === 'create_grocery_request') {
      const pendingRows = await db
        .select()
        .from(groceryRequests)
        .where(
          and(
            eq(groceryRequests.householdId, principal.householdId),
            eq(groceryRequests.status, 'pending'),
          ),
        );
      const pendingDomain = pendingRows.map(toDomainGroceryRequest);
      const similar = findSimilarPendingRequest(pendingDomain, decision.item);
      if (similar && !body.keepSeparate) {
        if (body.updateQuantity) {
          // Update the existing similar request's quantity (Cook edit on a
          // pending request; either active Cook may do this — AC#6). When no
          // explicit quantity is supplied, preserve the existing one rather
          // than clearing it.
          const nextQuantity =
            body.quantity !== undefined
              ? body.quantity
              : (decision.quantity ?? similar.quantityText);
          const updateDecision = decideRequestUpdate({
            current: similar,
            expectedVersion: similar.version,
            patch: { quantityText: nextQuantity },
            now: new Date(),
          });
          if (!updateDecision.ok) {
            return c.json(
              { error: 'similar_conflict', similar: serializeGroceryRequest(similar) },
              409,
            );
          }
          const updated = await db.transaction(async (tx) => {
            await tx
              .update(groceryRequests)
              .set({
                quantityText: updateDecision.next.quantityText,
                version: updateDecision.next.version,
              })
              .where(eq(groceryRequests.id, similar.id as string));
            await tx.insert(systemEvents).values({
              id: randomUUID(),
              householdId: principal.householdId,
              type: 'grocery_request.updated',
              actorId: principal.membershipId,
              entityType: 'grocery_request',
              entityId: similar.id as string,
              payload: {
                item: updateDecision.next.itemText,
                quantity: updateDecision.next.quantityText,
                status: 'pending',
              },
            });
            const [row] = await tx
              .select()
              .from(groceryRequests)
              .where(eq(groceryRequests.id, similar.id as string))
              .limit(1);
            return row;
          });
          await markSuggestionStatus(db, principal.householdId, suggestionId, 'confirmed');
          return c.json({
            request: serializeGroceryRequest(toDomainGroceryRequest(updated!)),
            updatedExisting: true,
          });
        }
        // Surface the deliberate choice; never silently merge (AC#5).
        return c.json({ error: 'similar_exists', similar: serializeGroceryRequest(similar) }, 409);
      }

      // No similar pending request (or the author chose Keep separate):
      // create a new pending Grocery Request + attributed Chat event.
      const requestId = randomUUID();
      const [created] = await db.transaction(async (tx) => {
        await tx.insert(groceryRequests).values({
          id: requestId,
          householdId: principal.householdId,
          itemText: decision.item,
          quantityText: decision.quantity,
          createdById: principal.membershipId,
        });
        await tx.insert(systemEvents).values({
          id: randomUUID(),
          householdId: principal.householdId,
          type: 'grocery_request.created',
          actorId: principal.membershipId,
          entityType: 'grocery_request',
          entityId: requestId,
          payload: { item: decision.item, quantity: decision.quantity, status: 'pending' },
        });
        const [row] = await tx
          .select()
          .from(groceryRequests)
          .where(eq(groceryRequests.id, requestId))
          .limit(1);
        return [row];
      });
      await markSuggestionStatus(db, principal.householdId, suggestionId, 'confirmed');
      return c.json({ request: serializeGroceryRequest(toDomainGroceryRequest(created!)) }, 201);
    }

    // Member/Owner → add a Suggested Grocery Cart item for review. This
    // never places an order or bypasses Groceries review (AC#8).
    const cartItemId = `${principal.householdId}:request:${suggestionId}`;
    await db.insert(suggestedCartItems).values({
      id: cartItemId,
      householdId: principal.householdId,
      ingredientKey: null,
      groceryRequestId: null,
      freeTextItem: decision.item.slice(0, 256),
      needDay: 'today',
      affectedMeals: [],
      confidence: 'unknown',
      memberState: 'pending',
      removalReason: null,
    });
    await markSuggestionStatus(db, principal.householdId, suggestionId, 'confirmed');
    return c.json({ cartItemId, item: decision.item }, 201);
  });

  /** Dismiss a private action suggestion (AC#3 — the author may dismiss). */
  app.post('/v1/households/:householdId/chat/suggestions/:suggestionId/dismiss', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const suggestionId = c.req.param('suggestionId');
    const [suggestionRow] = await db
      .select()
      .from(actionSuggestions)
      .where(eq(actionSuggestions.id, suggestionId))
      .limit(1);
    if (
      !suggestionRow ||
      suggestionRow.householdId !== principal.householdId ||
      suggestionRow.authorId !== principal.membershipId
    ) {
      return c.json({ error: 'not_found' }, 404);
    }
    await db
      .update(actionSuggestions)
      .set({ status: 'dismissed' })
      .where(eq(actionSuggestions.id, suggestionId));
    return c.json({ ok: true });
  });

  /**
   * List the caller's own pending private suggestions, so they survive app
   * restarts and reappear on relaunch (ticket 08, AC#3; issue 06 — private
   * suggestions survive app restarts). Only the author's pending suggestions
   * are returned; other participants never see them.
   */
  app.get('/v1/households/:householdId/chat/suggestions', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const rows = await db
      .select()
      .from(actionSuggestions)
      .where(
        and(
          eq(actionSuggestions.householdId, principal.householdId),
          eq(actionSuggestions.authorId, principal.membershipId),
          eq(actionSuggestions.status, 'pending'),
        ),
      )
      .orderBy(desc(actionSuggestions.createdAt));
    const now = new Date();
    const live = rows.filter((r) => r.expiresAt > now);
    return c.json({
      suggestions: live.map((r) => ({
        id: r.id,
        intent: r.intent as ChatIntent,
        status: r.status as ActionSuggestion['status'],
        sourceMessageId: r.sourceMessageId,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      })),
    });
  });
}

/**
 * Persist a PRIVATE action suggestion for a chat message author when an
 * actionable intent is detected (ticket 08, AC#1/AC#3). The suggestion is
 * visible only to its author, survives app restarts, and expires after 24
 * hours. It never mutates structured state until the author confirms it.
 *
 * A `unknown` intent produces no suggestion (returns null). A meal-change
 * intent is also persisted so the author can confirm it through the same
 * private flow; the structured mutation itself is owned by the meal-plan
 * routes once confirmed.
 */
export async function persistPrivateSuggestion(
  db: Database,
  householdId: string,
  authorId: string,
  sourceMessageId: string,
  intent: ChatIntent,
): Promise<{ id: string; intent: ChatIntent; status: 'pending' } | null> {
  if (intent.kind === 'unknown') return null;
  const suggestionId = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(actionSuggestions).values({
    id: suggestionId,
    householdId,
    authorId,
    sourceMessageId,
    intent,
    status: 'pending',
    expiresAt,
  });
  return { id: suggestionId, intent, status: 'pending' };
}

/** Flip a suggestion's status, scoped to its Household (AC#3 — private). */
export async function markSuggestionStatus(
  db: Database,
  householdId: string,
  suggestionId: string,
  status: ActionSuggestion['status'],
): Promise<void> {
  await db
    .update(actionSuggestions)
    .set({ status })
    .where(
      and(eq(actionSuggestions.id, suggestionId), eq(actionSuggestions.householdId, householdId)),
    );
}
