import type { GroceryRequestId, MembershipId } from './ids.js';
import type { HouseholdRole } from './roles.js';
import type {
  ActionSuggestion,
  ChatIntent,
  GroceryRequest,
  GroceryRequestStatus,
  Language,
} from './domain-types.js';

/**
 * The action layer for turning Cook (and Member) chat messages into
 * Member-approved Grocery Requests (ticket 08).
 *
 * The pure rules the server applies before any write:
 *
 * - a grocery intent with no item asks one plain follow-up question, never a
 *   form (ticket 08, AC#2);
 * - a detected action stays private to its author until explicitly confirmed
 *   (ticket 08, AC#3);
 * - confirmation rechecks the role and the suggestion's pending/non-expired
 *   state before any structured write (ticket 08, AC#4);
 * - similar concurrent pending requests are surfaced for a deliberate Update
 *   quantity / Keep separate choice, never merged silently (ticket 08, AC#5);
 * - either active Cook may update or cancel a pending request, but no Cook can
 *   change it after Member approval (ticket 08, AC#6);
 * - Members approve, reject, order now, or leave the request for the next
 *   Suggested Grocery Cart (ticket 08, AC#7);
 * - no Chat or Grocery Request action places an order or bypasses exact cart
 *   review and fresh Member checkout confirmation (ticket 08, AC#8).
 */

/** The follow-up question a missing essential detail triggers, per language. */
export function groceryFollowUpQuestion(lang: Language): string {
  return lang === 'hi' ? 'क्या चाहिए?' : 'What do you need?';
}

export type GrocerySuggestionDecision =
  | {
      ok: true;
      /** The role-appropriate structured action the server should perform. */
      action: 'create_grocery_request' | 'add_to_cart';
      item: string;
      quantity: string | null;
    }
  | { ok: false; reason: 'missing_item'; followUp: string }
  | { ok: false; reason: 'unknown_intent' }
  | { ok: false; reason: 'suggestion_not_pending' }
  | { ok: false; reason: 'suggestion_expired' };

/**
 * Resolve a private action suggestion into the role-appropriate structured
 * action. The server MUST call this after re-authorizing the author and
 * before performing any write.
 *
 * - A Cook confirms into a pending Grocery Request.
 * - A Household Member/Owner confirms into a Suggested Grocery Cart item. This
 *   never creates a provider cart side effect or bypasses Groceries review
 *   (issue 06 — Grocery intent).
 * - A grocery intent with an empty item asks one plain question instead of
 *   creating a record (ticket 08, AC#2; issue 06 — "I need grocery" asks for
 *   the missing item).
 */
export function decideGrocerySuggestion(input: {
  intent: ChatIntent;
  role: HouseholdRole;
  language: Language;
  suggestion: Pick<ActionSuggestion, 'status' | 'expiresAt'>;
  now: Date;
}): GrocerySuggestionDecision {
  if (input.suggestion.status !== 'pending') return { ok: false, reason: 'suggestion_not_pending' };
  if (new Date(input.suggestion.expiresAt).getTime() <= input.now.getTime()) {
    return { ok: false, reason: 'suggestion_expired' };
  }
  if (input.intent.kind !== 'grocery_request' && input.intent.kind !== 'add_to_cart') {
    return { ok: false, reason: 'unknown_intent' };
  }
  const item = input.intent.item.trim();
  if (!item) {
    return { ok: false, reason: 'missing_item', followUp: groceryFollowUpQuestion(input.language) };
  }
  const action: 'create_grocery_request' | 'add_to_cart' =
    input.role === 'cook' ? 'create_grocery_request' : 'add_to_cart';
  return { ok: true, action, item, quantity: input.intent.quantity };
}

/**
 * Normalize an item text for similarity comparison. Lowercases, collapses
 * whitespace, and strips punctuation. Hindi matras are preserved so that
 * "नारियल" and "नारियल" still match while "Tomato!" and "tomato," collapse
 * to the same key.
 */
export function normalizeItemText(raw: string): string {
  return (
    raw
      .toLowerCase()
      // strip punctuation but preserve letters, digits, combining marks (Hindi
      // matras like 'ा' are marks, not letters), and whitespace.
      .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Find a similar pending Grocery Request in the same Household. "Similar"
 * means a normalized item match (exact, after normalization). The server runs
 * this at commit so Chat can offer Update quantity or Keep separate rather
 * than emitting a duplicate (ticket 08, AC#5; issue 06 — never merge silently).
 *
 * Returns the first similar pending request (by creation order, oldest first)
 * or null. The caller decides which choice to offer; this never mutates.
 */
export function findSimilarPendingRequest(
  householdRequests: GroceryRequest[],
  itemText: string,
  excludeId?: GroceryRequestId,
): GroceryRequest | null {
  const target = normalizeItemText(itemText);
  if (!target) return null;
  const pending = householdRequests
    .filter((r) => r.status === 'pending' && r.id !== excludeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return pending.find((r) => normalizeItemText(r.itemText) === target) ?? null;
}

export type RequestUpdateDecision =
  | {
      ok: true;
      /** The materialized patch to persist, with version bumped and attributed. */
      next: {
        itemText: string;
        quantityText: string | null;
        status: GroceryRequestStatus;
        version: number;
      };
    }
  | {
      ok: false;
      reason: 'not_pending' | 'locked_after_approval' | 'stale_version' | 'empty_item';
      /** The current request, so the client can re-render with the actor. */
      current: GroceryRequest;
    };

/**
 * Decide whether a Cook may update or cancel a pending Grocery Request.
 *
 * - Either active Cook may update the item/quantity or cancel a pending
 *   request (ticket 08, AC#6). The capability check (cook role) is the
 *   server's job; this function owns the request-state rules.
 * - After Member approval, no Cook can change the request. The Cook sees the
 *   current state and must ask a Member to act (ticket 08, AC#6).
 * - Optimistic concurrency: a stale Cook edit cannot overwrite a newer
 *   version. The server shows the current state with the actor who changed it
 *   and requires fresh confirmation (issue 06 — no silent last-write-wins).
 */
export function decideRequestUpdate(input: {
  current: GroceryRequest;
  expectedVersion: number;
  patch: { itemText?: string; quantityText?: string | null; status?: 'cancelled' };
  now: Date;
}): RequestUpdateDecision {
  const { current, expectedVersion, patch } = input;
  if (current.status !== 'pending') {
    return { ok: false, reason: 'locked_after_approval', current };
  }
  if (current.version !== expectedVersion) {
    return { ok: false, reason: 'stale_version', current };
  }
  const nextItemText = patch.itemText !== undefined ? patch.itemText.trim() : current.itemText;
  if (!nextItemText) return { ok: false, reason: 'empty_item', current };
  const nextQuantityText =
    patch.quantityText !== undefined ? patch.quantityText?.trim() || null : current.quantityText;
  const nextStatus: GroceryRequestStatus = patch.status ?? current.status;
  return {
    ok: true,
    next: {
      itemText: nextItemText,
      quantityText: nextQuantityText,
      status: nextStatus,
      version: current.version + 1,
    },
  };
}

export type RequestResolutionDecision =
  | {
      ok: true;
      /** The next status. `approved` covers "order now" — no order is placed. */
      nextStatus: 'approved' | 'rejected';
      /** The bumped version to persist (consistent with decideRequestUpdate). */
      version: number;
      /**
       * True when the Member chose "order now". The request is approved and
       * surfaces in the next Suggested Grocery Cart review; no Grocery Order is
       * ever created here (ticket 08, AC#8).
       */
      orderNow: boolean;
    }
  | {
      ok: false;
      reason: 'not_pending' | 'stale_version';
      current: GroceryRequest;
    };

/**
 * Decide a Member's resolution of a pending Grocery Request.
 *
 * Members may approve, reject, or "order now" (approve for the next cart
 * review). Leaving the request pending is a no-op and never reaches this
 * function. A Cook may not resolve a request; the server enforces the
 * `approve_reject_request` capability before calling this.
 *
 * Critically, "order now" NEVER places an order. It only approves the request
 * so the Suggested Grocery Cart includes it; exact product matching, cart
 * review, and fresh checkout confirmation remain in Groceries (ticket 08,
 * AC#8; issue 06 — Chat can create a request but cannot place an order).
 */
export function decideRequestResolution(input: {
  current: GroceryRequest;
  expectedVersion: number;
  resolution: 'approve' | 'reject' | 'order_now';
}): RequestResolutionDecision {
  const { current, expectedVersion, resolution } = input;
  if (current.status !== 'pending') {
    return { ok: false, reason: 'not_pending', current };
  }
  if (current.version !== expectedVersion) {
    return { ok: false, reason: 'stale_version', current };
  }
  if (resolution === 'reject') {
    return { ok: true, nextStatus: 'rejected', orderNow: false, version: current.version + 1 };
  }
  return {
    ok: true,
    nextStatus: 'approved',
    orderNow: resolution === 'order_now',
    version: current.version + 1,
  };
}

/**
 * Whether a Cook may still mutate a request in its current state. Exposed for
 * the UI so a card can hide Cook edit/cancel controls once a Member has acted.
 */
export function cookMayMutate(status: GroceryRequestStatus): boolean {
  return status === 'pending';
}

/**
 * The actor label for a conflicting Cook mutation, rendered in the viewer's
 * language so Chat can show "Cook B set quantity to 5" without revealing any
 * Member-only detail (issue 06 — show the current state and the actor who
 * changed it).
 */
export function conflictActorLabel(actorName: string, lang: Language): string {
  return lang === 'hi' ? `${actorName} ने बदला` : `${actorName} changed this`;
}

/**
 * Guard: a Grocery Request resolution never places an order. This exists so
 * tests can prove the no-bypass invariant by construction (ticket 08, AC#8).
 * The function is intentionally total over its input: there is no code path
 * that returns an order placement.
 */
export function assertNoOrderPlacement(decision: RequestResolutionDecision): void {
  if (decision.ok) {
    if (
      (decision.nextStatus as string) === 'placed' ||
      (decision.nextStatus as string) === 'in_order'
    ) {
      throw new Error('Grocery Request resolution must never place an order.');
    }
  }
}

/** The Member-facing action labels for a pending request, in the viewer's language. */
export function memberActionLabels(lang: Language): {
  approve: string;
  reject: string;
  orderNow: string;
  leave: string;
} {
  if (lang === 'hi') {
    return {
      approve: 'स्वीकार करें',
      reject: 'अस्वीकार करें',
      orderNow: 'अभी ऑर्डर करें',
      leave: 'अगली कार्ट के लिए छोड़ें',
    };
  }
  return {
    approve: 'Approve',
    reject: 'Reject',
    orderNow: 'Order now',
    leave: 'Leave for next cart',
  };
}

/** The Cook-facing similarity choice labels (ticket 08, AC#5). */
export function similarityChoiceLabels(lang: Language): {
  updateQuantity: string;
  keepSeparate: string;
} {
  return lang === 'hi'
    ? { updateQuantity: 'मात्रा बदलें', keepSeparate: 'अलग रखें' }
    : { updateQuantity: 'Update quantity', keepSeparate: 'Keep separate' };
}

export type { MembershipId };
