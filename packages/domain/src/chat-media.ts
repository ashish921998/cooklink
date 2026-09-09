import { canEditOrDeleteMessage } from './chat-lifecycle.js';
import { detectIntent } from './intent.js';
import type { MembershipId } from './ids.js';
import type { ChatIntent, ChatMessage, ChatMessageKind, VoiceTranscript } from './domain-types.js';

/**
 * Photo and voice-note media rules for Household Chat (ticket 06 — Add
 * private photo and voice-note Chat).
 *
 * The schema and repository already carry `kind: 'photo' | 'voice'`,
 * `mediaRef`, `caption`, and the `voice_transcripts` row. This module owns the
 * PURE domain policy that sits above them: which fields a given message kind
 * may carry, the two-minute voice bound, the transcript-correction window, and
 * the rule that correcting a transcript or caption re-runs intent detection
 * without rewriting the original media.
 */

/** A voice note is at most two minutes (issue 06, AC#1). */
export const MAX_VOICE_DURATION_MS = 2 * 60 * 1000;

/** Photo captions are short; the column is varchar(512). */
export const MAX_CAPTION_LENGTH = 512;

export type MessageShapeDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'body_and_media_mutually_exclusive'
        | 'caption_requires_photo'
        | 'voice_has_no_caption'
        | 'media_required'
        | 'body_required'
        | 'caption_too_long';
    };

/**
 * Validate that a message of `kind` carries exactly the fields its shape
 * allows. The server MUST call this before persisting a message so a photo
 * never silently stores a body and a voice note never stores a caption.
 *
 * - text: body required, no mediaRef, no caption.
 * - photo: mediaRef required, optional caption, no body.
 * - voice: mediaRef required, no body, no caption.
 */
export function validateMessageShape(input: {
  kind: ChatMessageKind;
  body: string | null;
  caption: string | null;
  mediaRef: string | null;
}): MessageShapeDecision {
  const body = trimOrNull(input.body);
  const caption = trimOrNull(input.caption);
  const mediaRef = trimOrNull(input.mediaRef);

  if (caption && caption.length > MAX_CAPTION_LENGTH) {
    return { ok: false, reason: 'caption_too_long' };
  }

  switch (input.kind) {
    case 'text':
      if (!body) return { ok: false, reason: 'body_required' };
      if (mediaRef) return { ok: false, reason: 'body_and_media_mutually_exclusive' };
      if (caption) return { ok: false, reason: 'caption_requires_photo' };
      return { ok: true };
    case 'photo':
      if (!mediaRef) return { ok: false, reason: 'media_required' };
      if (body) return { ok: false, reason: 'body_and_media_mutually_exclusive' };
      return { ok: true };
    case 'voice':
      if (!mediaRef) return { ok: false, reason: 'media_required' };
      if (body) return { ok: false, reason: 'body_and_media_mutually_exclusive' };
      if (caption) return { ok: false, reason: 'voice_has_no_caption' };
      return { ok: true };
  }
}

/** Normalize a nullable string: null/whitespace → null, else trimmed. */
function trimOrNull(v: string | null): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type TranscriptCorrectionDecision =
  | { ok: true }
  | { ok: false; reason: 'not_voice' | 'not_author' | 'window_expired' | 'deleted' | 'empty' };

/**
 * Decide whether `actorId` may correct the transcript of `message` at `now`.
 * Reuses the 15-minute own-message edit window (issue 06, AC#23 — the author
 * may correct the transcript during the message's edit window) and additionally
 * requires the message to be a voice note.
 */
export function canCorrectTranscript(input: {
  actorId: MembershipId;
  message: Pick<ChatMessage, 'kind' | 'senderId' | 'serverCreatedAt' | 'deletedAt'>;
  correctedText: string;
  now: Date;
}): TranscriptCorrectionDecision {
  if (input.message.kind !== 'voice') return { ok: false, reason: 'not_voice' };
  const trimmed = input.correctedText.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  const base = canEditOrDeleteMessage({
    actorId: input.actorId,
    message: {
      senderId: input.message.senderId,
      serverCreatedAt: input.message.serverCreatedAt,
      deletedAt: input.message.deletedAt,
    },
    now: input.now,
  });
  if (!base.ok) return base;
  return { ok: true };
}

/**
 * The text a reader should see for a voice note: the corrected transcript when
 * the author has provided one, otherwise the automatic transcript. A failed or
 * pending transcript yields null so the UI can label it (issue 06, AC#4 —
 * uncertain output is labelled and correctable).
 */
export function effectiveTranscript(transcript: VoiceTranscript | null): string | null {
  if (!transcript) return null;
  if (transcript.status !== 'ready') return null;
  const corrected = transcript.correctedTranscript?.trim();
  return corrected && corrected.length > 0 ? corrected : transcript.transcript;
}

/**
 * Whether a transcript should be labelled "automatic" (no correction yet) so
 * the UI can mark uncertain output (issue 06, AC#4).
 */
export function isAutomaticTranscript(transcript: VoiceTranscript | null): boolean {
  if (!transcript || transcript.status !== 'ready') return false;
  const corrected = transcript.correctedTranscript?.trim();
  return !corrected || corrected.length === 0;
}

/**
 * The source text to run intent detection against for a given message shape
 * (issue 06, AC#23 — correcting a transcript or photo caption re-runs intent
 * detection against the corrected text). Returns null when there is no text to
 * analyse (e.g. a photo without a caption, or a voice note whose transcript is
 * not ready).
 */
export function intentSourceText(
  message: Pick<ChatMessage, 'kind' | 'body' | 'caption'>,
  transcript: VoiceTranscript | null,
): string | null {
  switch (message.kind) {
    case 'text':
      return message.body;
    case 'photo':
      return message.caption;
    case 'voice':
      return effectiveTranscript(transcript);
  }
}

/**
 * Run intent detection against a message's current effective text. Returns
 * `unknown` when there is no analysable text. This is the single entry point
 * the server uses both on initial send and on transcript/caption correction,
 * so the "re-run without rewriting the original media" rule is enforced by
 * construction (issue 06, AC#5).
 */
export function detectMessageIntent(
  message: Pick<ChatMessage, 'kind' | 'body' | 'caption'>,
  transcript: VoiceTranscript | null,
): ChatIntent {
  const text = intentSourceText(message, transcript);
  if (!text) return { kind: 'unknown' };
  return detectIntent(text);
}

/**
 * Media access is revoked when a message is deleted (the mediaRef is cleared)
 * or when the owning membership is removed. This predicate lets the server
 * decide whether to serve a media object without a separate column (issue 06,
 * AC#7 — removing membership immediately revokes media and transcript access).
 */
export function isMediaAccessible(
  message: Pick<ChatMessage, 'deletedAt' | 'mediaRef' | 'householdId'>,
  viewerHouseholdId: string,
): boolean {
  if (message.deletedAt) return false;
  if (!message.mediaRef) return false;
  return message.householdId === viewerHouseholdId;
}
