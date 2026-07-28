/**
 * Household membership lifecycle (issue 03 — removal). The pure half of the
 * Owner's "remove a Member or Cook" action, kept out of the request handler so
 * the rules can be unit-tested without Postgres and stay beside the invite rules.
 */

export type MembershipRemovalError = 'already_removed' | 'cannot_remove_self';

export interface RemovalInput {
  /** The acting Owner's membership id. */
  actorMembershipId: string;
  /** The id of the membership the Owner is trying to remove. */
  targetMembershipId: string;
  /** The current status of the target membership row. */
  targetStatus: string;
  /** The role held by the target membership. */
  targetRole: 'owner' | 'member' | 'cook';
}

/**
 * Resolve whether an Owner may remove a membership. Returns `null` when the
 * removal may proceed, otherwise the plain-English error the handler surfaces.
 *
 * An Owner never removes themselves here (close-household is a separate
 * action), and an already-removed row is a no-op rather than an error.
 */
export function validateMembershipRemoval(input: RemovalInput): MembershipRemovalError | null {
  if (input.actorMembershipId === input.targetMembershipId) return 'cannot_remove_self';
  if (input.targetStatus !== 'active') return 'already_removed';
  return null;
}
