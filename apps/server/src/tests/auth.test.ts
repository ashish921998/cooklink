import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClerkIdentity } from '../auth.js';

test('Clerk authentication is unavailable when either server key is missing', async () => {
  const previousSecretKey = process.env.CLERK_SECRET_KEY;
  const previousPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;

  try {
    // Intentional, reviewed placeholder: it is a dictionary word with no
    // digits, never a real Clerk key. The git-history scanner allowlists
    // this exact value in `KNOWN_PLACEHOLDERS` (apps/server/src/secrets-
    // history.ts); the prefix `sk_test_` is NOT allowlisted, so real-shaped
    // keys are still caught. Keep this value in sync with that set.
    process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
    delete process.env.CLERK_PUBLISHABLE_KEY;

    const identity = await resolveClerkIdentity(new Request('https://api.example.test'));
    assert.equal(identity, null);
  } finally {
    if (previousSecretKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = previousSecretKey;

    if (previousPublishableKey === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
    else process.env.CLERK_PUBLISHABLE_KEY = previousPublishableKey;
  }
});
