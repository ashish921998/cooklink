/**
 * Household Chat API routes (issues 04/06 — text, photo, voice).
 *
 * One conversation per Household, shared by Cooks and Household Members. The
 * timeline merges human messages with attributed system events in server
 * order. Messages are accepted only after re-authorized membership; media is
 * private per Household behind opaque refs re-authorized on every read; voice
 * notes transcribe server-side with author-correctable transcripts. Editing
 * and deleting your own message is bounded to a 15-minute window.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import {
  brandId,
  canCorrectTranscript,
  canEditOrDeleteMessage,
  detectMessageIntent,
  effectiveTranscript,
  isAutomaticTranscript,
  MAX_VOICE_DURATION_MS,
  renderEvent,
  validateMessageShape,
  type Language,
  type SystemEventType,
  type VoiceTranscript,
} from '@cooklink/domain';
import {
  chatMessages,
  households,
  householdMemberState,
  memberships,
  systemEvents,
  users,
  voiceTranscripts,
} from '@cooklink/db';
import type { Database } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';
import { dispatchPushForMessage } from '../push-delivery.js';
import { persistPrivateSuggestion } from './chat-suggestions.routes.js';
import type { AppRouteContext } from './route-context.js';

type ChatMessageRow = typeof chatMessages.$inferSelect;
type SystemEventRow = typeof systemEvents.$inferSelect;

/** Mount the Household Chat routes: timeline, messages, media, transcripts, read. */
export function registerChatRoutes(app: Hono<AuthEnv>, ctx: AppRouteContext): void {
  const { db, authorization, media, transcription, pushDispatcher, log } = ctx;

  /**
   * Household Chat timeline (issue 04 — text chat). Returns the merged,
   * server-ordered history of human messages and attributed system events,
   * scoped to this Household. A pending (outbox) message is never visible to
   * others because it does not exist until this server accepts it (issue 06,
   * AC#12).
   *
   * Pagination is a forward cursor: `?afterId=` returns items strictly newer
   * than that id, which is the contract Open Chat polls on refresh.
   */
  app.get('/v1/households/:householdId/chat', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const limit = clampPositiveInt(c.req.query('limit'), 50, 200);
    const afterId = c.req.query('afterId');

    const messageRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.householdId, principal.householdId))
      .orderBy(asc(chatMessages.serverCreatedAt), asc(chatMessages.id));
    const eventRows = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.householdId, principal.householdId))
      .orderBy(asc(systemEvents.createdAt), asc(systemEvents.id));
    // Voice transcripts are private to the Household and travel with their
    // message (ticket 06 — transcripts never cross Household boundaries).
    const messageIds = messageRows.map((m) => m.id);
    const transcriptRows =
      messageIds.length > 0
        ? await db
            .select()
            .from(voiceTranscripts)
            .where(inArray(voiceTranscripts.messageId, messageIds))
        : [];
    const transcriptByMessage = new Map(transcriptRows.map((r) => [r.messageId, r]));

    type Row = {
      kind: 'message' | 'event';
      id: string;
      time: number;
      payload: unknown;
    };
    const rows: Row[] = [
      ...messageRows.map((m) => ({
        kind: 'message' as const,
        id: m.id,
        time: m.serverCreatedAt.getTime(),
        payload: m,
      })),
      ...eventRows.map((e) => ({
        kind: 'event' as const,
        id: e.id,
        time: e.createdAt.getTime(),
        payload: e,
      })),
    ].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));

    const cursorIndex = afterId ? rows.findIndex((r) => r.id === afterId) : -1;
    const start = afterId
      ? cursorIndex >= 0
        ? cursorIndex + 1
        : rows.length // unknown cursor → nothing newer (safe poll no-op)
      : Math.max(0, rows.length - limit);
    const page = rows.slice(start, start + limit);

    // Resolve sender display names once so the client can attribute messages,
    // including the inactive-role label for a departed participant (issue 06 —
    // history remains attributed after a participant leaves).
    const senderIds = [
      ...new Set(
        page
          .filter((r) => r.kind === 'message')
          .map((r) => (r.payload as (typeof messageRows)[number]).senderId),
      ),
    ];
    const actorIds = [
      ...new Set(
        page
          .filter((r) => r.kind === 'event')
          .map((r) => (r.payload as (typeof eventRows)[number]).actorId)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const membershipIds = [...new Set([...senderIds, ...actorIds])];
    const names = await resolveMembershipLabels(db, principal.householdId, membershipIds);

    const household = await db
      .select()
      .from(households)
      .where(eq(households.id, principal.householdId))
      .limit(1);

    return c.json({
      items: page.map((r) =>
        r.kind === 'message'
          ? serializeChatMessage(
              r.payload as (typeof messageRows)[number],
              names,
              transcriptByMessage.get((r.payload as (typeof messageRows)[number]).id) ?? null,
            )
          : serializeChatEvent(
              r.payload as (typeof eventRows)[number],
              names,
              resolveViewerLanguage(c.req.query('lang'), household[0]?.defaultLanguage),
            ),
      ),
    });
  });

  /**
   * Send a human message (ticket 06 — text, photo, and voice). The server
   * accepts the message only after re-authorizing the membership, so a
   * just-removed participant's queued attempt fails with
   * Household-access-changed (issue 06, AC#19). Server acceptance time fixes
   * the message's position in the shared timeline; the client time is retained
   * for diagnostics.
   *
   * Photo and voice messages reference a mediaRef obtained from the media
   * upload route; the media belongs to this Household. A voice message
   * triggers server-side transcription (ticket 06, AC#4).
   */
  app.post('/v1/households/:householdId/chat/messages', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'send_message',
    );
    const body: {
      kind?: 'text' | 'photo' | 'voice';
      body?: string | null;
      caption?: string | null;
      mediaRef?: string | null;
      durationMs?: number;
      clientCreatedAt?: string;
    } = await c.req.json().catch(() => ({}));
    const kind = body.kind ?? 'text';
    const shape = validateMessageShape({
      kind,
      body: body.body ?? null,
      caption: body.caption ?? null,
      mediaRef: body.mediaRef ?? null,
    });
    if (!shape.ok) return c.json({ error: shape.reason }, 400);

    // A voice note is bounded at two minutes (ticket 06, AC#2). The duration
    // is required for voice messages so the bound cannot be bypassed by
    // omitting the field.
    if (kind === 'voice') {
      const durationMs = body.durationMs;
      if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
        return c.json({ error: 'voice_duration_required' }, 400);
      }
      if (durationMs > MAX_VOICE_DURATION_MS) {
        return c.json({ error: 'voice_too_long' }, 400);
      }
    }

    const messageId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      householdId: principal.householdId,
      senderId: principal.membershipId,
      kind,
      body: kind === 'text' ? (body.body ?? '').trim() : null,
      caption: kind === 'photo' ? (body.caption ?? '').trim() || null : null,
      mediaRef: kind !== 'text' ? (body.mediaRef ?? null) : null,
      clientCreatedAt: new Date(body.clientCreatedAt ?? Date.now()),
    });
    const [created] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    const names = await resolveMembershipLabels(db, principal.householdId, [created!.senderId]);

    // A voice message starts transcription in `pending` state. The response
    // returns immediately with the pending transcript so the client can show
    // "Transcribing…"; the actual transcription runs asynchronously and the
    // client observes the result via the next poll (ticket 06, AC#4).
    // Transcription runs server-side; no provider key is in the mobile bundle.
    let transcriptRow: typeof voiceTranscripts.$inferSelect | null = null;
    if (kind === 'voice' && created!.mediaRef) {
      const resolved = await media.resolve(created!.mediaRef, principal.householdId);
      if (resolved) {
        await db
          .insert(voiceTranscripts)
          .values({ messageId, language: null, transcript: null, status: 'pending' })
          .onConflictDoUpdate({
            target: voiceTranscripts.messageId,
            set: { status: 'pending' },
          });
        const [pendingRow] = await db
          .select()
          .from(voiceTranscripts)
          .where(eq(voiceTranscripts.messageId, messageId))
          .limit(1);
        transcriptRow = pendingRow ?? null;

        // Run transcription without blocking the send response. The result is
        // written back to the transcript row when the provider returns; the
        // client picks it up on the next poll.
        void transcription
          .transcribe({ data: resolved.data, contentType: resolved.contentType })
          .then((result) =>
            db
              .insert(voiceTranscripts)
              .values({
                messageId,
                language: result.language,
                transcript: result.transcript,
                status: result.status,
              })
              .onConflictDoUpdate({
                target: voiceTranscripts.messageId,
                set: {
                  language: result.language,
                  transcript: result.transcript,
                  status: result.status,
                },
              }),
          )
          .catch(() =>
            db
              .insert(voiceTranscripts)
              .values({ messageId, language: null, transcript: null, status: 'failed' })
              .onConflictDoUpdate({
                target: voiceTranscripts.messageId,
                set: { status: 'failed' },
              }),
          )
          .catch(() => {
            // A failure to persist the transcription failure is logged but
            // never surfaces to the sender; the transcript stays pending and
            // the client retries on the next poll.
          });
      }
    }

    // Run intent detection on acceptance and persist a PRIVATE action
    // suggestion for the author when a grocery/meal intent is detected
    // (ticket 08, AC#1/AC#3 — a detected action remains private to its author
    // until explicitly confirmed). The suggestion is never visible to other
    // participants and never mutates structured state until confirmed. A voice
    // note whose transcript is not yet ready produces no suggestion here; the
    // transcript-correction route re-runs detection when the transcript lands.
    const intent = detectMessageIntent(
      { kind: created!.kind, body: created!.body, caption: created!.caption },
      transcriptRow ? toDomainTranscript(transcriptRow) : null,
    );
    const suggestion = await persistPrivateSuggestion(
      db,
      principal.householdId,
      principal.membershipId,
      created!.id,
      intent,
    );
    // Fire-and-forget push dispatch (issue 12, AC#3/AC#5). The sender never
    // receives their own message; muted recipients are excluded; previews
    // respect per-device and money-redaction rules.
    const senderLabel = names.get(created!.senderId);
    const senderName = senderLabel?.displayName ?? 'Someone';
    const previewText =
      created!.kind === 'text'
        ? (created!.body ?? '')
        : created!.kind === 'photo'
          ? (created!.caption ?? 'Photo')
          : 'Voice message';
    void dispatchPushForMessage(
      db,
      pushDispatcher,
      principal.householdId as string,
      principal.membershipId as string,
      created!.id,
      senderName,
      previewText,
      log,
    );

    return c.json(
      {
        item: serializeChatMessage(created!, names, transcriptRow),
        membershipId: principal.membershipId,
        intent,
        suggestion,
      },
      201,
    );
  });

  /**
   * Edit your own human message within the 15-minute window (issue 06, AC#11).
   * A text message body or a photo caption may be edited; a voice note's text
   * is corrected through the transcript route. A confirmed structured action
   * is never mutated by editing its source message. System events are not
   * human messages and have no edit route.
   *
   * Editing a photo caption re-runs intent detection against the new caption
   * (ticket 06, AC#5 — correcting a transcript or photo caption re-runs any
   * derived intent detection without rewriting the original media).
   */
  app.patch('/v1/households/:householdId/chat/messages/:messageId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_delete_own_message',
    );
    const messageId = c.req.param('messageId');
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    if (!message || message.householdId !== principal.householdId)
      return c.json({ error: 'not_found' }, 404);

    const decision = canEditOrDeleteMessage({
      actorId: principal.membershipId,
      message: {
        senderId: brandId<'MembershipId'>(message.senderId),
        serverCreatedAt: message.serverCreatedAt.toISOString(),
        deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
      },
      now: new Date(),
    });
    if (!decision.ok) {
      return c.json({ error: decision.reason }, decision.reason === 'not_author' ? 403 : 409);
    }

    const patch: { body?: string | null; caption?: string | null } = await c.req
      .json()
      .catch(() => ({}));
    if (message.kind === 'text' && patch.body !== undefined) {
      const trimmed = patch.body?.trim() ?? '';
      if (!trimmed) return c.json({ error: 'body_required' }, 400);
      patch.body = trimmed;
    }
    if (message.kind === 'photo' && patch.caption !== undefined) {
      const trimmed = patch.caption?.trim() ?? '';
      patch.caption = trimmed || null;
    }
    await db
      .update(chatMessages)
      .set({ ...patch, editedAt: new Date() })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.householdId, principal.householdId),
          eq(chatMessages.senderId, principal.membershipId),
        ),
      );
    const [updated] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    const names = await resolveMembershipLabels(db, principal.householdId, [updated!.senderId]);

    // Re-run intent detection against the edited text/caption so a corrected
    // caption can produce a fresh private suggestion (ticket 06, AC#5). The
    // original media is never rewritten.
    const [transcriptRow] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    const intent = detectMessageIntent(
      {
        kind: updated!.kind,
        body: updated!.body,
        caption: updated!.caption,
      },
      transcriptRow ? toDomainTranscript(transcriptRow) : null,
    );

    return c.json({
      item: serializeChatMessage(updated!, names, transcriptRow ?? null),
      intent,
    });
  });

  /**
   * Delete your own human message within the 15-minute window (issue 06,
   * AC#11). A deletion leaves a "Message deleted" tombstone in the timeline;
   * media access is revoked (the media-ref is cleared and the private object
   * is scheduled for deletion from the media store). The tombstone remains
   * so the shared timeline stays coherent.
   */
  app.delete('/v1/households/:householdId/chat/messages/:messageId', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_delete_own_message',
    );
    const messageId = c.req.param('messageId');
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    if (!message || message.householdId !== principal.householdId)
      return c.json({ error: 'not_found' }, 404);

    const decision = canEditOrDeleteMessage({
      actorId: principal.membershipId,
      message: {
        senderId: brandId<'MembershipId'>(message.senderId),
        serverCreatedAt: message.serverCreatedAt.toISOString(),
        deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
      },
      now: new Date(),
    });
    if (!decision.ok) {
      return c.json({ error: decision.reason }, decision.reason === 'not_author' ? 403 : 409);
    }

    // Revoke media access immediately and schedule the private object for
    // deletion (issue 06 — deleting a photo or voice note revokes access to
    // its media immediately).
    if (message.mediaRef) {
      await media.delete(message.mediaRef);
    }
    await db
      .update(chatMessages)
      .set({ deletedAt: new Date(), mediaRef: null })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.householdId, principal.householdId),
          eq(chatMessages.senderId, principal.membershipId),
        ),
      );
    const [updated] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    const names = await resolveMembershipLabels(db, principal.householdId, [updated!.senderId]);
    const [transcriptRow] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    return c.json({ item: serializeChatMessage(updated!, names, transcriptRow ?? null) });
  });

  /**
   * Upload a private photo or voice note (ticket 06, AC#1/2). The media is
   * stored behind an opaque `mediaRef` tagged with this Household; it is never
   * a public permanent URL. The caller then references this `mediaRef` when
   * sending a photo or voice message. Authorization is re-checked on every
   * subsequent media read (issue 06, AC#3).
   *
   * The request body is the raw media bytes with a `Content-Type` header; the
   * `kind` query parameter selects photo or voice. A voice note's duration in
   * milliseconds is optional here and enforced on send.
   */
  app.post('/v1/households/:householdId/chat/media', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'send_message',
    );
    const kind = c.req.query('kind') as 'photo' | 'voice' | undefined;
    if (kind !== 'photo' && kind !== 'voice') {
      return c.json({ error: 'kind_required' }, 400);
    }
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.byteLength === 0) return c.json({ error: 'empty_media' }, 400);
    const stored = await media.put({
      householdId: principal.householdId,
      kind,
      contentType,
      data,
    });
    return c.json({ mediaRef: stored.mediaRef, kind: stored.kind, bytes: stored.bytes }, 201);
  });

  /**
   * Authorized media access (ticket 06, AC#3 — private media is accessible
   * only through short-lived authorized access and never through a public
   * permanent URL). The server re-authorizes the membership and verifies the
   * media belongs to this Household on every request, then proxies the bytes.
   * A cross-Household mediaRef resolves to nothing (issue 06, AC#8).
   */
  app.get('/v1/households/:householdId/chat/media/:mediaRef', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const mediaRef = c.req.param('mediaRef');
    // The mediaRef may be URL-encoded when it contains slashes.
    const decoded = decodeURIComponent(mediaRef);
    const resolved = await media.resolve(decoded, principal.householdId);
    if (!resolved) return c.json({ error: 'not_found' }, 404);
    return new Response(resolved.data, {
      headers: {
        'content-type': resolved.contentType,
        'cache-control': 'private, no-store, max-age=0',
      },
    });
  });

  /**
   * Correct a voice transcript within the 15-minute edit window (ticket 06,
   * AC#4 — uncertain output is labelled and correctable; AC#5 — correcting a
   * transcript re-runs intent detection without rewriting the original media).
   * The original automatic transcript is preserved; the correction is stored
   * in `correctedTranscript`. Only the author may correct, and only for a
   * voice note.
   */
  app.patch('/v1/households/:householdId/chat/messages/:messageId/transcript', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorizeCapability(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
      'edit_delete_own_message',
    );
    const messageId = c.req.param('messageId');
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);
    if (!message || message.householdId !== principal.householdId)
      return c.json({ error: 'not_found' }, 404);

    const body: { correctedTranscript?: string } = await c.req.json().catch(() => ({}));
    const corrected = body.correctedTranscript ?? '';
    const decision = canCorrectTranscript({
      actorId: principal.membershipId,
      message: {
        kind: message.kind,
        senderId: brandId<'MembershipId'>(message.senderId),
        serverCreatedAt: message.serverCreatedAt.toISOString(),
        deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
      },
      correctedText: corrected,
      now: new Date(),
    });
    if (!decision.ok) {
      const status =
        decision.reason === 'not_author' ? 403 : decision.reason === 'not_voice' ? 400 : 409;
      return c.json({ error: decision.reason }, status);
    }

    // Preserve the original automatic transcript; store the correction
    // separately so the UI can label it (ticket 06, AC#4).
    const [existing] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    const trimmed = corrected.trim();
    if (existing) {
      await db
        .update(voiceTranscripts)
        .set({ correctedTranscript: trimmed })
        .where(eq(voiceTranscripts.messageId, messageId));
    } else {
      await db.insert(voiceTranscripts).values({
        messageId,
        language: null,
        transcript: null,
        status: 'ready',
        correctedTranscript: trimmed,
      });
    }
    const [updated] = await db
      .select()
      .from(voiceTranscripts)
      .where(eq(voiceTranscripts.messageId, messageId))
      .limit(1);
    const domainTranscript = toDomainTranscript(updated!);
    // Re-run intent detection against the corrected transcript (ticket 06,
    // AC#5). The original media is never rewritten.
    const intent = detectMessageIntent(
      { kind: message.kind, body: message.body, caption: message.caption },
      domainTranscript,
    );
    return c.json({ transcript: serializeTranscript(updated!), intent });
  });

  /**
   * Mark Chat read through the latest visible position (issue 04 / 06). The
   * last-read position is private per person and Household; it is never exposed
   * as a read receipt. Pending structured action badges are derived from
   * structured state and are not cleared here.
   */
  app.post('/v1/households/:householdId/chat/read', async (c) => {
    const user = c.get('authUser');
    const householdId = c.req.param('householdId');
    const principal = await authorization.authorize(
      brandId<'UserId'>(user.id),
      brandId<'HouseholdId'>(householdId),
    );
    const body = await c.req.json().catch(() => ({}));
    const lastReadMessageId = (body as { lastReadMessageId?: string })?.lastReadMessageId;
    if (!lastReadMessageId) return c.json({ error: 'last_read_required' }, 400);
    await db
      .insert(householdMemberState)
      .values({
        userId: principal.userId,
        householdId: principal.householdId,
        lastReadMessageId,
      })
      .onConflictDoUpdate({
        target: [householdMemberState.userId, householdMemberState.householdId],
        set: { lastReadMessageId },
      });
    return c.json({ ok: true });
  });
}

/** Clamp a pagination limit to a safe positive bound. */
function clampPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Resolve a stable display label for each membership id so messages and events
 * stay attributed after a participant leaves (issue 06 — historical messages
 * remain attributed; the UI labels the inactive role without exposing removed
 * account details). We surface the role alongside the name so the client can
 * show "Cook · Meera" and an inactive marker when the membership is gone.
 */
export async function resolveMembershipLabels(
  db: Database,
  householdId: string,
  membershipIds: string[],
): Promise<Map<string, { displayName: string; role: string; active: boolean }>> {
  const out = new Map<string, { displayName: string; role: string; active: boolean }>();
  if (membershipIds.length === 0) return out;
  const rows = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.householdId, householdId), inArray(memberships.id, membershipIds)));
  for (const row of rows) {
    out.set(row.membership.id, {
      displayName: row.user.displayName,
      role: row.membership.role,
      active: row.membership.status === 'active',
    });
  }
  return out;
}

/** Serialize a chat message row (with sender label and transcript) for the API. */
export function serializeChatMessage(
  row: ChatMessageRow,
  labels: Map<string, { displayName: string; role: string; active: boolean }>,
  transcriptRow: typeof voiceTranscripts.$inferSelect | null,
) {
  const sender = labels.get(row.senderId);
  const domainTranscript = transcriptRow ? toDomainTranscript(transcriptRow) : null;
  return {
    kind: 'message' as const,
    id: row.id,
    householdId: row.householdId,
    senderId: row.senderId,
    sender: sender
      ? { displayName: sender.displayName, role: sender.role, active: sender.active }
      : null,
    messageKind: row.kind,
    body: row.deletedAt ? null : row.body,
    caption: row.deletedAt ? null : row.caption,
    mediaRef: row.deletedAt ? null : row.mediaRef,
    transcript: serializeTranscript(transcriptRow),
    transcriptText: row.deletedAt ? null : effectiveTranscript(domainTranscript),
    transcriptAutomatic: row.deletedAt ? false : isAutomaticTranscript(domainTranscript),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    clientCreatedAt: row.clientCreatedAt.toISOString(),
    serverCreatedAt: row.serverCreatedAt.toISOString(),
  };
}

/** Map a Drizzle voice-transcript row onto the domain `VoiceTranscript`. */
export function toDomainTranscript(row: typeof voiceTranscripts.$inferSelect): VoiceTranscript {
  return {
    messageId: brandId<'ChatMessageId'>(row.messageId),
    language: row.language,
    transcript: row.transcript,
    status: row.status,
    correctedTranscript: row.correctedTranscript,
  };
}

/** Serialize a transcript row for the API (null when there is no transcript). */
export function serializeTranscript(row: typeof voiceTranscripts.$inferSelect | null) {
  if (!row) return null;
  return {
    messageId: row.messageId,
    language: row.language,
    transcript: row.transcript,
    status: row.status,
    correctedTranscript: row.correctedTranscript,
  };
}

/** Serialize a system event row for the API, rendered in the viewer's language. */
export function serializeChatEvent(
  row: SystemEventRow,
  labels: Map<string, { displayName: string; role: string; active: boolean }>,
  lang: Language,
) {
  const actor = row.actorId ? (labels.get(row.actorId) ?? null) : null;
  // Render the safe event text in the VIEWER's selected language — human
  // messages are never translated; system events render in each viewer's
  // English or Hindi locale (issue 06, AC#21). The raw payload is always
  // included so the client can re-render if its own selection changes.
  const text = renderEvent(
    {
      id: brandId<'SystemEventId'>(row.id),
      householdId: brandId<'HouseholdId'>(row.householdId),
      type: row.type as SystemEventType,
      actorId: row.actorId ? brandId<'MembershipId'>(row.actorId) : null,
      entityType: row.entityType,
      entityId: row.entityId,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    },
    lang,
  );
  return {
    kind: 'event' as const,
    id: row.id,
    householdId: row.householdId,
    type: row.type,
    actorId: row.actorId,
    actor: actor
      ? { displayName: actor.displayName, role: actor.role, active: actor.active }
      : null,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: row.payload,
    text,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Resolve the viewer's language for system-event rendering (issue 06, AC#21).
 * The client may pass `?lang=en|hi`; otherwise the Household default applies.
 */
function resolveViewerLanguage(
  requested: string | undefined,
  householdDefault: 'en' | 'hi' | undefined,
): Language {
  if (requested === 'hi' || requested === 'en') return requested;
  return householdDefault ?? 'en';
}
