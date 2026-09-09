import type { ChatMessageId, MembershipId } from './ids.js';
import type { ChatMessage } from './domain-types.js';

/**
 * Human-message lifecycle policy (issue 06 — Send, edit, and delete lifecycle).
 *
 * A person may edit or delete their own human message for 15 minutes after
 * server acceptance. An edit is labelled "Edited"; a deletion leaves a
 * "Message deleted" tombstone. Another person may never edit or delete a
 * message, and a deleted message can no longer be mutated. System events are
 * not human messages and are never editable by participants.
 */

/** The edit/delete window after server acceptance (15 minutes). */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export type EditDeleteDecision =
  { ok: true } | { ok: false; reason: 'not_author' | 'window_expired' | 'deleted' };

/**
 * Decide whether `actorId` may edit or delete `message` at `now`. The server
 * MUST call this before touching a human message; it is the single source of
 * truth for the own-message lifecycle rule.
 *
 * Authorization order: deleted tombstones are final; only the author may act;
 * and the author loses the ability once the 15-minute window from server
 * acceptance closes.
 */
export function canEditOrDeleteMessage(input: {
  actorId: MembershipId;
  message: Pick<ChatMessage, 'senderId' | 'serverCreatedAt' | 'deletedAt'>;
  now: Date;
}): EditDeleteDecision {
  if (input.message.deletedAt) return { ok: false, reason: 'deleted' };
  if (input.message.senderId !== input.actorId) return { ok: false, reason: 'not_author' };
  const accepted = new Date(input.message.serverCreatedAt).getTime();
  const elapsed = input.now.getTime() - accepted;
  if (elapsed >= EDIT_WINDOW_MS) return { ok: false, reason: 'window_expired' };
  return { ok: true };
}

/** True while the author can still edit or delete (convenience for the UI). */
export function isWithinEditWindow(message: ChatMessage, now: Date): boolean {
  return canEditOrDeleteMessage({ actorId: message.senderId, message, now }).ok;
}

/**
 * Whether a timeline message renders as a deleted tombstone (issue 06 — a
 * deletion leaves "Message deleted" in the timeline rather than removing it).
 */
export function isDeletedTombstone(message: Pick<ChatMessage, 'deletedAt'>): boolean {
  return Boolean(message.deletedAt);
}

/** Identity helper for callers that already hold a typed id. */
export function sameMessage(a: ChatMessageId, b: ChatMessageId): boolean {
  return a === b;
}
