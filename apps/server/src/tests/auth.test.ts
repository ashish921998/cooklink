import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClerkIdentity } from '../auth.js';

test('Clerk authentication is unavailable when either server key is missing', async () => {
  const previousSecretKey = process.env.CLERK_SECRET_KEY;
  const previousPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;

  try {
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
