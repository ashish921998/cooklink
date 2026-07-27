import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from './api';

/**
 * Household text Chat client (issue 04 — text chat).
 *
 * Contract this implements:
 * - The timeline is server-ordered, oldest first, and merges human messages
 *   with safely rendered attributed system events (issue 06).
 * - Open Chat refreshes by a forward cursor (`?afterId=` returns strictly newer
 *   items), supports pull-to-refresh, and maintains a private last-read
 *   position per person (issue 06, AC#17).
 * - Offline messages show Sending / Sent / Failed in a Household-scoped outbox
 *   and cannot become visible or actionable to others before server acceptance
 *   (issue 06, AC#12). A pending item is local-only until the server accepts
 *   it; it is never rendered inside the shared timeline.
 */

export type ChatMessageKind = 'text' | 'photo' | 'voice';

/** A sender/actor label so the client can attribute every message and event. */
export interface ChatParticipant {
  displayName: string;
  role: string;
  active: boolean;
}

export interface ChatTranscript {
  language: 'en' | 'hi' | null;
  transcript: string | null;
  status: 'pending' | 'ready' | 'failed';
  correctedTranscript: string | null;
}

/** A human message as returned by the server. */
export interface ChatMessageItem {
  kind: 'message';
  id: string;
  householdId: string;
  senderId: string;
  sender: ChatParticipant | null;
  messageKind: ChatMessageKind;
  body: string | null;
  caption: string | null;
  mediaRef: string | null;
  deletedAt: string | null;
  editedAt: string | null;
  clientCreatedAt: string;
  serverCreatedAt: string;
  transcript: ChatTranscript | null;
}

/** An attributed, immutable system event rendered in the viewer's language. */
export interface ChatEventItem {
  kind: 'event';
  id: string;
  householdId: string;
  type: string;
  actorId: string | null;
  actor: ChatParticipant | null;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  text: string;
  createdAt: string;
}

export type TimelineItem = ChatMessageItem | ChatEventItem;

export interface AccessProbe {
  ok: boolean;
  role?: string;
  householdId?: string;
  membershipId?: string;
}

/** A local outbox row. It never appears in another participant's Chat. */
export interface OutboxItem {
  localId: string;
  householdId: string;
  body: string;
  clientCreatedAt: string;
  state: 'sending' | 'sent' | 'failed';
  /**
   * `household_access_changed` when the server rejected the send because the
   * membership is gone (issue 06, AC#19 — queued messages from a removed
   * membership fail permanently with "Household access changed"). Otherwise null.
   */
  failureReason: 'household_access_changed' | null;
  /** The server id once accepted, so the row can be retired from the outbox. */
  serverId?: string;
}

interface TimelineResponse {
  items: TimelineItem[];
}

interface SendResponse {
  membershipId: string;
  item: ChatMessageItem;
}

const POLL_INTERVAL_MS = 8_000;

/**
 * The 15-minute edit/delete window (issue 06, AC#11). The server is the source
 * of truth for this rule; the mobile client mirrors the constant only to hide
 * controls once the window has clearly passed. Kept here so the mobile bundle
 * does not pull in the domain package.
 */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Drive one Household's Chat: load the newest page, poll for newer items via
 * the forward cursor, and own the local outbox. The outbox is intentionally
 * in-memory and Household-scoped: it resets when the Household changes so a
 * Cook switching Households never retains another Household's draft or state
 * (issue 03 — no leakage).
 */
export function useHouseholdChat(householdId: string, ownMembershipId: string | null) {
  const api = useApi();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const newestIdRef = useRef<string | null>(null);

  const sortByTime = useCallback((rows: TimelineItem[]): TimelineItem[] => {
    const timeOf = (t: TimelineItem) => (t.kind === 'message' ? t.serverCreatedAt : t.createdAt);
    return [...rows].sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  }, []);

  const absorb = useCallback(
    (incoming: TimelineItem[]) => {
      if (incoming.length === 0) return;
      setItems((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        const merged = [...prev];
        for (const item of incoming) {
          if (!seen.has(item.id)) {
            merged.push(item);
            seen.add(item.id);
          }
        }
        return sortByTime(merged);
      });
      const newest = sortByTime(incoming).at(-1);
      if (newest) newestIdRef.current = newest.id;
    },
    [sortByTime],
  );

  // Initial load of the newest page. Resolved fresh whenever the Household
  // changes so no other Household's history lingers.
  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<TimelineResponse>(`/v1/households/${householdId}/chat?limit=50`);
      setItems(sortByTime(data.items));
      newestIdRef.current = data.items.length > 0 ? sortByTime(data.items).at(-1)!.id : null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load chat.');
    } finally {
      setLoading(false);
    }
  }, [api, householdId, sortByTime]);

  // Reset state on Household change — no leakage across Households.
  useEffect(() => {
    setItems([]);
    setOutbox([]);
    newestIdRef.current = null;
    setLoading(true);
    void loadInitial();
  }, [householdId, loadInitial]);

  // Forward-cursor polling for newer items. Unknown cursors are a safe no-op
  // on the server, so a brand-new Household (no newest id yet) simply loads
  // the tail instead.
  const poll = useCallback(async () => {
    const afterId = newestIdRef.current;
    const path = afterId
      ? `/v1/households/${householdId}/chat?afterId=${encodeURIComponent(afterId)}&limit=50`
      : `/v1/households/${householdId}/chat?limit=50`;
    try {
      const data = await api<TimelineResponse>(path);
      absorb(data.items);
    } catch {
      // Polling failures are transient; the next interval retries.
    }
  }, [absorb, api, householdId]);

  useEffect(() => {
    const handle = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [poll]);

  const send = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || !ownMembershipId) return;
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const clientCreatedAt = new Date().toISOString();
      const pending: OutboxItem = {
        localId,
        householdId,
        body: trimmed,
        clientCreatedAt,
        state: 'sending',
        failureReason: null,
      };
      setOutbox((prev) => [...prev, pending]);
      try {
        const result = await api<SendResponse>(`/v1/households/${householdId}/chat/messages`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'text', body: trimmed, clientCreatedAt }),
        });
        // The accepted message enters the timeline; the outbox row retires.
        absorb([result.item]);
        setOutbox((prev) =>
          prev.map((row) =>
            row.localId === localId ? { ...row, state: 'sent', serverId: result.item.id } : row,
          ),
        );
      } catch (err) {
        // A 403/404 from the protected route means Household access is gone:
        // the server re-authorizes on send, so a just-removed membership's
        // queued message fails permanently with "Household access changed"
        // (issue 06, AC#19).
        const message = err instanceof Error ? err.message : '';
        const accessChanged = /\b(40[34])\b/.test(message);
        setOutbox((prev) =>
          prev.map((row) =>
            row.localId === localId
              ? {
                  ...row,
                  state: 'failed',
                  failureReason: accessChanged ? 'household_access_changed' : null,
                }
              : row,
          ),
        );
      }
    },
    [absorb, api, householdId, ownMembershipId],
  );

  const retry = useCallback(
    (localId: string) => {
      const row = outbox.find((r) => r.localId === localId);
      if (!row) return;
      void send(row.body);
      // Drop the failed row; the retry enqueues a fresh sending row.
      setOutbox((prev) => prev.filter((r) => r.localId !== localId));
    },
    [outbox, send],
  );

  const cancel = useCallback((localId: string) => {
    setOutbox((prev) => prev.filter((r) => r.localId !== localId));
  }, []);

  const edit = useCallback(
    async (messageId: string, body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const res = await api<{ item: ChatMessageItem }>(
        `/v1/households/${householdId}/chat/messages/${messageId}`,
        { method: 'PATCH', body: JSON.stringify({ body: trimmed }) },
      );
      setItems((prev) => prev.map((t) => (t.id === messageId ? res.item : t)));
    },
    [api, householdId],
  );

  const remove = useCallback(
    async (messageId: string) => {
      const res = await api<{ item: ChatMessageItem }>(
        `/v1/households/${householdId}/chat/messages/${messageId}`,
        { method: 'DELETE' },
      );
      setItems((prev) => prev.map((t) => (t.id === messageId ? res.item : t)));
    },
    [api, householdId],
  );

  const markRead = useCallback(
    async (upToId: string) => {
      try {
        await api<{ ok: boolean }>(`/v1/households/${householdId}/chat/read`, {
          method: 'POST',
          body: JSON.stringify({ lastReadMessageId: upToId }),
        });
      } catch {
        // Read state is best-effort; never block the conversation on it.
      }
    },
    [api, householdId],
  );

  const refresh = useCallback(async () => {
    await poll();
    await loadInitial();
  }, [loadInitial, poll]);

  return {
    items,
    outbox,
    loading,
    error,
    send,
    retry,
    cancel,
    edit,
    remove,
    markRead,
    refresh,
  };
}
