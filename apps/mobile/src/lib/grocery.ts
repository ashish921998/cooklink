import { useCallback } from 'react';
import { useApi } from './api';

/**
 * Grocery Request client (ticket 08 — turn Cook messages into Member-approved
 * Grocery Requests).
 *
 * The pending queue is shared by Cooks and Members. Cooks may update item/
 * quantity or cancel a pending request (capability
 * `edit_cancel_pending_request`); Members approve, reject, or "order now"
 * (capability `approve_reject_request`). Neither approval nor "order now"
 * places an order; exact product matching, cart review, and fresh checkout
 * confirmation remain in Groceries (ticket 08, AC#8).
 */

export type GroceryRequestStatus =
  'pending' | 'approved' | 'rejected' | 'cancelled' | 'in_order' | 'fulfilled';

export interface GroceryRequestItem {
  id: string;
  householdId: string;
  itemText: string;
  quantityText: string | null;
  status: GroceryRequestStatus;
  createdById: string;
  createdAt: string;
  resolvedById: string | null;
  resolvedAt: string | null;
  version: number;
}

export type GroceryResolution = 'approve' | 'reject' | 'order_now';

/** The conflict body returned when a similar pending request exists (AC#5). */
export interface SimilarExistsError {
  error: 'similar_exists';
  similar: GroceryRequestItem;
}

/** The follow-up body returned when an essential detail is missing (AC#2). */
export interface MissingItemError {
  error: 'missing_item';
  followUp: string;
}

export function useGroceryRequests(householdId: string) {
  const api = useApi();

  const list = useCallback(
    async (status?: GroceryRequestStatus): Promise<GroceryRequestItem[]> => {
      const path = status
        ? `/v1/households/${householdId}/grocery-requests?status=${status}`
        : `/v1/households/${householdId}/grocery-requests`;
      const res = await api<{ requests: GroceryRequestItem[] }>(path);
      return res.requests;
    },
    [api, householdId],
  );

  /** A Cook updates item/quantity or cancels a pending request (AC#6). */
  const update = useCallback(
    async (
      requestId: string,
      expectedVersion: number,
      patch: { itemText?: string; quantityText?: string | null; status?: 'cancelled' },
    ): Promise<GroceryRequestItem> => {
      const res = await api<{ request: GroceryRequestItem }>(
        `/v1/households/${householdId}/grocery-requests/${requestId}`,
        { method: 'PATCH', body: JSON.stringify({ expectedVersion, ...patch }) },
      );
      return res.request;
    },
    [api, householdId],
  );

  /**
   * A Member resolves a pending request (AC#7). "order now" approves for the
   * next Suggested Grocery Cart review and never places an order (AC#8).
   */
  const resolve = useCallback(
    async (
      requestId: string,
      expectedVersion: number,
      resolution: GroceryResolution,
    ): Promise<{ request: GroceryRequestItem; orderNow: boolean }> => {
      const res = await api<{ request: GroceryRequestItem; orderNow: boolean }>(
        `/v1/households/${householdId}/grocery-requests/${requestId}/resolve`,
        { method: 'POST', body: JSON.stringify({ expectedVersion, resolution }) },
      );
      return res;
    },
    [api, householdId],
  );

  return { list, update, resolve };
}
