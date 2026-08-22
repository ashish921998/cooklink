import { AuthorizationDeniedError, type Capability } from './errors.js';
import type { HouseholdId, MembershipId, UserId } from './ids.js';
import type { HouseholdRole } from './roles.js';
import { can } from './roles.js';
import type { Household, Membership, NotificationLevel } from './domain-types.js';

/**
 * An authorized principal: the result of proving that a user is an ACTIVE
 * member of a specific Household with a specific role.
 *
 * Every household-scoped server operation begins by resolving a Principal
 * through {@link Authorization.authorize}; the principal's `householdId` is
 * then used to scope every subsequent read and write. There is no database
 * row-level security (issue 07, AC#6), so this is the only authorization
 * boundary.
 */
export interface Principal {
  userId: UserId;
  householdId: HouseholdId;
  membershipId: MembershipId;
  role: HouseholdRole;
  notificationDefault: NotificationLevel;
}

export interface MembershipSnapshot {
  membership: Membership;
  household: Household;
}

/**
 * The authorization port. The server supplies a Drizzle-backed implementation;
 * tests supply an in-memory one. Both MUST agree that only `status === 'active'`
 * memberships authorize, and that a removed/closed household denies.
 *
 * This is deliberately minimal: it resolves membership + household for a
 * (user, household) pair. All other household-scoped data access goes through
 * the {@link Repository} port and is scoped by the resolved principal.
 */
export interface AuthorizationLookup {
  findActiveMembership(
    userId: UserId,
    householdId: HouseholdId,
  ): Promise<MembershipSnapshot | null>;
}

export class Authorization {
  constructor(private readonly lookup: AuthorizationLookup) {}

  /**
   * Resolve and prove an active membership. Throws
   * {@link AuthorizationDeniedError} (which the server logs and returns as
   * 403/404) when the user is not an active member of the household or the
   * household is closed.
   */
  async authorize(userId: UserId, householdId: HouseholdId): Promise<Principal> {
    const snap = await this.lookup.findActiveMembership(userId, householdId);
    if (!snap) {
      throw new AuthorizationDeniedError('You are not an active member of this household.', {
        userId,
        householdId,
        capability: 'read_chat',
      });
    }
    if (snap.membership.status !== 'active') {
      throw new AuthorizationDeniedError('Household access has changed.', {
        userId,
        householdId,
      });
    }
    if (snap.household.closedAt) {
      throw new AuthorizationDeniedError('This household is closed.', {
        userId,
        householdId,
      });
    }
    return {
      userId,
      householdId,
      membershipId: snap.membership.id,
      role: snap.membership.role,
      notificationDefault: snap.membership.notificationDefault,
    };
  }

  /** Authorize and additionally require a capability (issue 06 matrix). */
  async authorizeCapability(
    userId: UserId,
    householdId: HouseholdId,
    capability: Capability,
  ): Promise<Principal> {
    const principal = await this.authorize(userId, householdId);
    if (!can(principal.role, capability)) {
      throw new AuthorizationDeniedError(`Your role cannot perform this action (${capability}).`, {
        userId,
        householdId,
        capability,
      });
    }
    return principal;
  }
}

/** Runtime assertion that a principal still holds a capability. */
export function requireCapability(principal: Principal, capability: Capability): void {
  if (!can(principal.role, capability)) {
    throw new AuthorizationDeniedError(`Your role cannot perform this action (${capability}).`, {
      userId: principal.userId,
      householdId: principal.householdId,
      capability,
    });
  }
}
