import { useCallback, useEffect, useRef, useState } from 'react';
import { devAuthHeaders, useApi, useTokenResolver } from './api';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * Household Chat client (issue 04 — text chat; ticket 06 — photo and voice).
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
 * - Photo and voice media are uploaded to a private, authorized endpoint and
 *   referenced by an opaque mediaRef; media is never a public permanent URL
 *   (ticket 06, AC#3).
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
  /** The voice transcript (null for text/photo). */
  transcript: ChatTranscript | null;
  /** The effective transcript text (corrected if present, else automatic). */
  transcriptText: string | null;
  /** Whether the transcript is still the automatic, uncorrected one. */
  transcriptAutomatic: boolean;
  deletedAt: string | null;
  editedAt: string | null;
  clientCreatedAt: string;
  serverCreatedAt: string;
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
  /** The display label for the outbox row (text body, "Photo", or "Voice note"). */
  body: string;
  /** The message kind this outbox row represents. */
  kind: ChatMessageKind;
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

/** The detected intent shape returned by the server for a message/suggestion. */
export interface ChatIntentResponse {
  kind: string;
  item?: string;
  quantity?: string | null;
}

/** A private action suggestion detected from the author's message (ticket 08). */
export interface ActionSuggestionResponse {
  id: string;
  intent: ChatIntentResponse;
  status: 'pending' | 'confirmed' | 'dismissed' | 'expired' | 'failed';
}

interface SendResponse {
  membershipId: string;
  item: ChatMessageItem;
  /** The detected intent for the author's message (unknown → no suggestion). */
  intent: ChatIntentResponse;
  /** A private suggestion persisted for the author, or null when no actionable intent. */
  suggestion: ActionSuggestionResponse | null;
}

interface MediaUploadResponse {
  mediaRef: string;
  kind: ChatMessageKind;
  bytes: number;
}

interface TranscriptCorrectResponse {
  transcript: ChatTranscript;
  intent: ChatIntentResponse;
}

interface CaptionEditResponse {
  item: ChatMessageItem;
  intent: ChatIntentResponse;
}

/** The maximum voice note duration (ticket 06, AC#2 — two minutes). */
export const MAX_VOICE_DURATION_MS = 2 * 60 * 1000;

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
  const resolveToken = useTokenResolver();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The latest private action suggestion for the author (ticket 08, AC#3).
  // Private to the author; never rendered for other participants.
  const [pendingSuggestion, setPendingSuggestion] = useState<ActionSuggestionResponse | null>(null);
  const newestIdRef = useRef<string | null>(null);
  // Stable refs for the media upload fetch (which sends raw bytes, not JSON).
  const tokenResolverRef = useRef(resolveToken);
  tokenResolverRef.current = resolveToken;
  const apiUrlRef = useRef(API_URL);

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

  /**
   * Rehydrate the author's pending private suggestions so they survive app
   * restarts (ticket 08, AC#3; issue 06). Only the author's own pending
   * suggestions are returned by the server; other participants never see them.
   * We surface the most recent one for the composer's private suggestion card.
   */
  const loadPendingSuggestions = useCallback(async () => {
    try {
      const data = await api<{ suggestions: ActionSuggestionResponse[] }>(
        `/v1/households/${householdId}/chat/suggestions`,
      );
      setPendingSuggestion(data.suggestions[0] ?? null);
    } catch {
      // Best-effort rehydration; never block Chat on it.
    }
  }, [api, householdId]);

  // Reset state on Household change — no leakage across Households.
  useEffect(() => {
    setItems([]);
    setOutbox([]);
    newestIdRef.current = null;
    setLoading(true);
    setPendingSuggestion(null);
    void loadInitial();
    void loadPendingSuggestions();
  }, [householdId, loadInitial, loadPendingSuggestions]);

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
        kind: 'text',
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
        setPendingSuggestion(result.suggestion ?? null);
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

  /**
   * Upload a private photo or voice note and return the opaque mediaRef. The
   * media is never a public permanent URL; it is read back only through the
   * authorized media endpoint (ticket 06, AC#3). Upload progress and retry
   * state are owned by the caller (the Composer); a failed upload cannot
   * create an orphaned visible message because no message is sent until the
   * upload succeeds and the send is accepted (ticket 06, AC#6).
   */
  const uploadMedia = useCallback(
    async (
      kind: 'photo' | 'voice',
      data: ArrayBuffer | Uint8Array,
      contentType: string,
    ): Promise<string> => {
      const token = await tokenResolverRef.current();
      const res = await fetch(
        `${apiUrlRef.current}/v1/households/${householdId}/chat/media?kind=${kind}`,
        {
          method: 'POST',
          headers: {
            'content-type': contentType,
            ...devAuthHeaders,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: data as BodyInit,
        },
      );
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const result = (await res.json()) as MediaUploadResponse;
      return result.mediaRef;
    },
    [householdId],
  );

  /**
   * Send a photo message with an optional caption. The mediaRef must have been
   * obtained from {@link uploadMedia}. A failed send stays in the outbox and
   * never enters the shared timeline (ticket 06, AC#6).
   */
  const sendPhoto = useCallback(
    async (mediaRef: string, caption: string | null) => {
      if (!ownMembershipId) return;
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const clientCreatedAt = new Date().toISOString();
      const pending: OutboxItem = {
        localId,
        householdId,
        body: caption ?? 'Photo',
        kind: 'photo',
        clientCreatedAt,
        state: 'sending',
        failureReason: null,
      };
      setOutbox((prev) => [...prev, pending]);
      try {
        const result = await api<SendResponse>(`/v1/households/${householdId}/chat/messages`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'photo', mediaRef, caption, clientCreatedAt }),
        });
        absorb([result.item]);
        setPendingSuggestion(result.suggestion ?? null);
        setOutbox((prev) =>
          prev.map((row) =>
            row.localId === localId ? { ...row, state: 'sent', serverId: result.item.id } : row,
          ),
        );
      } catch (err) {
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

  /**
   * Send a voice note. The mediaRef must have been obtained from
   * {@link uploadMedia}. The duration is bounded at two minutes (ticket 06,
   * AC#2); the server enforces the bound, and the client disables recording
   * past the limit.
   */
  const sendVoice = useCallback(
    async (mediaRef: string, durationMs: number) => {
      if (!ownMembershipId) return;
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const clientCreatedAt = new Date().toISOString();
      const pending: OutboxItem = {
        localId,
        householdId,
        body: 'Voice note',
        kind: 'voice',
        clientCreatedAt,
        state: 'sending',
        failureReason: null,
      };
      setOutbox((prev) => [...prev, pending]);
      try {
        const result = await api<SendResponse>(`/v1/households/${householdId}/chat/messages`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'voice', mediaRef, durationMs, clientCreatedAt }),
        });
        absorb([result.item]);
        // A voice note with a pending transcript produces no suggestion yet;
        // the transcript-correction flow re-runs intent detection when ready.
        setPendingSuggestion(result.suggestion ?? null);
        setOutbox((prev) =>
          prev.map((row) =>
            row.localId === localId ? { ...row, state: 'sent', serverId: result.item.id } : row,
          ),
        );
      } catch (err) {
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

  /**
   * Build the authorized media URL for a mediaRef. The URL goes through the
   * server's authorized endpoint, which re-checks the membership on every
   * request (ticket 06, AC#3). The token is attached by the caller at fetch
   * time.
   */
  const mediaUrl = useCallback(
    (mediaRef: string) =>
      `${apiUrlRef.current}/v1/households/${householdId}/chat/media/${encodeURIComponent(mediaRef)}`,
    [householdId],
  );

  /**
   * Correct a voice transcript within the 15-minute edit window (ticket 06,
   * AC#4 — uncertain output is labelled and correctable). The correction
   * re-runs intent detection server-side (AC#5).
   */
  const correctTranscript = useCallback(
    async (messageId: string, correctedText: string) => {
      const res = await api<TranscriptCorrectResponse>(
        `/v1/households/${householdId}/chat/messages/${messageId}/transcript`,
        { method: 'PATCH', body: JSON.stringify({ correctedTranscript: correctedText }) },
      );
      setItems((prev) =>
        prev.map((t) =>
          t.id === messageId && t.kind === 'message'
            ? {
                ...t,
                transcript: res.transcript,
                transcriptText: res.transcript.correctedTranscript ?? t.transcriptText,
                transcriptAutomatic: false,
              }
            : t,
        ),
      );
      return res;
    },
    [api, householdId],
  );

  /**
   * Edit a photo caption within the 15-minute edit window (ticket 06, AC#5 —
   * editing a caption re-runs intent detection). Returns the re-detected
   * intent so the UI can surface a fresh private suggestion.
   */
  const editCaption = useCallback(
    async (messageId: string, caption: string) => {
      const res = await api<CaptionEditResponse>(
        `/v1/households/${householdId}/chat/messages/${messageId}`,
        { method: 'PATCH', body: JSON.stringify({ caption }) },
      );
      setItems((prev) => prev.map((t) => (t.id === messageId ? res.item : t)));
      return res;
    },
    [api, householdId],
  );

  const retry = useCallback(
    (localId: string) => {
      const row = outbox.find((r) => r.localId === localId);
      if (!row) return;
      if (row.kind === 'text') void send(row.body);
      // Photo and voice retries require re-upload; the caller cancels and
      // re-sends through the composer. A failed media row is dismissed.
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

  /**
   * Confirm a private action suggestion (ticket 08, AC#4). The server
   * re-authorizes and performs the role-appropriate structured mutation. A
   * `missing_item` response carries a plain follow-up question (AC#2); a
   * `similar_exists` response carries the similar request for an Update
   * quantity / Keep separate choice (AC#5). Never places an order (AC#8).
   */
  const refresh = useCallback(async () => {
    await poll();
    await loadInitial();
  }, [loadInitial, poll]);

  const confirmSuggestion = useCallback(
    async (
      suggestionId: string,
      options?: { keepSeparate?: boolean; updateQuantity?: boolean; quantity?: string | null },
    ): Promise<unknown> => {
      const res = await api<unknown>(
        `/v1/households/${householdId}/chat/suggestions/${suggestionId}/confirm`,
        { method: 'POST', body: JSON.stringify(options ?? {}) },
      );
      setPendingSuggestion(null);
      await refresh();
      return res;
    },
    [api, householdId, refresh],
  );

  /** Dismiss a private action suggestion (ticket 08, AC#3). */
  const dismissSuggestion = useCallback(
    async (suggestionId: string): Promise<void> => {
      await api<{ ok: boolean }>(
        `/v1/households/${householdId}/chat/suggestions/${suggestionId}/dismiss`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setPendingSuggestion(null);
    },
    [api, householdId],
  );

  return {
    items,
    outbox,
    loading,
    error,
    send,
    sendPhoto,
    sendVoice,
    uploadMedia,
    mediaUrl,
    correctTranscript,
    editCaption,
    retry,
    cancel,
    edit,
    remove,
    markRead,
    refresh,
    pendingSuggestion,
    confirmSuggestion,
    dismissSuggestion,
  };
}
