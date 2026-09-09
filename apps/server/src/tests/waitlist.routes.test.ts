import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, waitlistEntries } from '@cooklink/db';
import { createApp } from '../app.js';
import type { AuthEnv } from '../auth.js';
import { registerWaitlistRoutes } from '../routes/waitlist.routes.js';

function recordingDatabase() {
  const rows: Array<{ id: string; email: string; source: string }> = [];
  const db = {
    insert: () => ({
      values: (row: { id: string; email: string; source: string }) => ({
        onConflictDoNothing: async () => {
          if (!rows.some((candidate) => candidate.email === row.email)) rows.push(row);
        },
      }),
    }),
  } as unknown as ReturnType<typeof createDatabase>;
  return { db, rows };
}

test(
  'waitlist signup normalizes, persists, and deduplicates email addresses',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is required for Postgres app tests' },
  async () => {
    const db = createDatabase(process.env.DATABASE_URL);
    const app = createApp(db);
    const email = `waitlist-${crypto.randomUUID()}@example.com`;

    const first = await app.request('/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `  ${email.toUpperCase()}  `, source: 'landing' }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });

    const duplicate = await app.request('/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, source: 'landing' }),
    });
    assert.equal(duplicate.status, 200);

    const stored = await db.select().from(waitlistEntries).where(eq(waitlistEntries.email, email));
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.source, 'landing');

    await db.delete(waitlistEntries).where(eq(waitlistEntries.email, email));
  },
);

test('waitlist signup rejects invalid email addresses', async () => {
  const app = createApp({} as ReturnType<typeof createDatabase>);
  const response = await app.request('/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email' }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'valid_email_required' });
});

test('waitlist signup normalizes data without requiring a live database', async () => {
  const { db, rows } = recordingDatabase();
  const app = new Hono<AuthEnv>();
  registerWaitlistRoutes(app, db);

  const response = await app.request('/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.10' },
    body: JSON.stringify({ email: '  PERSON@Example.COM ', source: 'untrusted-source' }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    rows.map(({ email, source }) => ({ email, source })),
    [{ email: 'person@example.com', source: 'landing' }],
  );
});

test('waitlist honeypot returns success without storing the address', async () => {
  const { db, rows } = recordingDatabase();
  const app = new Hono<AuthEnv>();
  registerWaitlistRoutes(app, db);

  const response = await app.request('/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bot@example.com', website: 'https://spam.example' }),
  });

  assert.equal(response.status, 200);
  assert.equal(rows.length, 0);
});

test('waitlist limits accepted submissions by Railway client IP', async () => {
  const { db, rows } = recordingDatabase();
  const app = new Hono<AuthEnv>();
  registerWaitlistRoutes(app, db, { rateLimit: 2, rateWindowMs: 60_000, now: () => 1_000 });
  const submit = (email: string) =>
    app.request('/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.20' },
      body: JSON.stringify({ email }),
    });

  assert.equal((await submit('first@example.com')).status, 200);
  assert.equal((await submit('second@example.com')).status, 200);
  const limited = await submit('third@example.com');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(rows.length, 2);
});

test('waitlist rejects request bodies over four kilobytes', async () => {
  const { db } = recordingDatabase();
  const app = new Hono<AuthEnv>();
  registerWaitlistRoutes(app, db);

  const response = await app.request('/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'person@example.com', padding: 'x'.repeat(4_096) }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'payload_too_large' });
});
