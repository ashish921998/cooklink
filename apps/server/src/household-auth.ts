import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@cooklink/db';
import { households, memberships } from '@cooklink/db';
import { id, type AuthorizationLookup, type MembershipSnapshot } from '@cooklink/domain';
import type { HouseholdId, UserId } from '@cooklink/domain';

export class DrizzleAuthorizationLookup implements AuthorizationLookup {
  constructor(private readonly db: Database) {}

  async findActiveMembership(
    userId: UserId,
    householdId: HouseholdId,
  ): Promise<MembershipSnapshot | null> {
    const [row] = await this.db
      .select({ membership: memberships, household: households })
      .from(memberships)
      .innerJoin(households, eq(households.id, memberships.householdId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.householdId, householdId),
          eq(memberships.status, 'active'),
          isNull(households.closedAt),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      membership: {
        ...row.membership,
        id: id<'MembershipId'>(row.membership.id),
        userId: id<'UserId'>(row.membership.userId),
        householdId: id<'HouseholdId'>(row.membership.householdId),
        joinedAt: row.membership.joinedAt.toISOString(),
        removedAt: row.membership.removedAt?.toISOString() ?? null,
      },
      household: {
        ...row.household,
        id: id<'HouseholdId'>(row.household.id),
        healthEmphasis: row.household.healthEmphasis,
        createdAt: row.household.createdAt.toISOString(),
        closedAt: row.household.closedAt?.toISOString() ?? null,
      },
    };
  }
}
