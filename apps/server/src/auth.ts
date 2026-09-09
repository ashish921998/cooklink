import type { MiddlewareHandler } from 'hono';
import { createClerkClient } from '@clerk/backend';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '@cooklink/db';
import { users } from '@cooklink/db';

export interface AuthenticatedUser {
  id: string;
  clerkUserId: string;
  phone: string;
  displayName: string;
}

export interface AuthEnv {
  Variables: {
    authUser: AuthenticatedUser;
  };
}

export function authMiddleware(db: Database): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const identity = await resolveClerkIdentity(c.req.raw);
    if (!identity) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, identity.clerkUserId))
      .limit(1);
    if (!user) {
      const profile = identity.phone
        ? { phone: identity.phone, displayName: identity.displayName }
        : await fetchClerkProfile(identity.clerkUserId);
      if (!profile?.phone) {
        return c.json({ error: 'verified_phone_required' }, 409);
      }
      try {
        await db.insert(users).values({
          id: randomUUID(),
          clerkUserId: identity.clerkUserId,
          phone: normalizePhone(profile.phone),
          displayName: profile.displayName || 'Cooklink user',
        });
      } catch {
        // A concurrent first request may have created the same Clerk profile.
        // Re-read through the unique clerk_user_id index before failing.
      }
      [user] = await db
        .select()
        .from(users)
        .where(eq(users.clerkUserId, identity.clerkUserId))
        .limit(1);
      if (!user) {
        return c.json({ error: 'profile_creation_failed' }, 500);
      }
    }

    c.set('authUser', {
      id: user.id,
      clerkUserId: user.clerkUserId,
      phone: user.phone,
      displayName: user.displayName,
    });
    await next();
  };
}

interface ClerkIdentity {
  clerkUserId: string;
  phone: string | null;
  displayName: string;
}

export async function resolveClerkIdentity(req: Request): Promise<ClerkIdentity | null> {
  if (process.env.COOKLINK_DEV_AUTH === 'true') {
    const devUser = req.headers.get('x-clerk-user-id');
    if (devUser) {
      return {
        clerkUserId: devUser,
        phone: req.headers.get('x-cooklink-dev-phone'),
        displayName: req.headers.get('x-cooklink-dev-name') ?? 'Development user',
      };
    }
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) return null;

  const clerk = createClerkClient({ secretKey, publishableKey });
  const requestState = await clerk.authenticateRequest(req);
  if (!requestState.isSignedIn) return null;
  const clerkUserId = requestState.toAuth().userId;
  if (!clerkUserId) return null;

  // The signed session proves the Clerk user id. Existing Cooklink profiles
  // are loaded from PostgreSQL by the middleware, avoiding a Clerk Management
  // API request on every authenticated API call. The profile is fetched from
  // Clerk only below when a user signs in for the first time.
  return { clerkUserId, phone: null, displayName: '' };
}

async function fetchClerkProfile(
  clerkUserId: string,
): Promise<{ phone: string | null; displayName: string } | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) return null;
  const clerk = createClerkClient({ secretKey, publishableKey });
  const clerkUser = await clerk.users.getUser(clerkUserId);
  const phone =
    clerkUser.phoneNumbers.find((candidate) => candidate.id === clerkUser.primaryPhoneNumberId) ??
    clerkUser.phoneNumbers[0];
  return {
    phone: phone?.phoneNumber ?? null,
    displayName:
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
      clerkUser.username ||
      'Cooklink user',
  };
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}
