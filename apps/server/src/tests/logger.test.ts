import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { Hono } from 'hono';
import { requestLogger, logAuthorizationDenied } from '../logger.js';
import type { AuthEnv } from '../auth.js';

/**
 * Structured-logging unit tests (issue 07, AC#19). Verifies every request
 * emits a JSON line with user, Household, route, status, and latency, and
 * that authorization denials are logged as structured `authorization_denied`
 * events — without touching Postgres.
 */

function collectingLogger(sink: unknown[]): Logger {
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      sink.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return pino(stream);
}

test('requestLogger emits user, household, route, status, and latency', async () => {
  const events: unknown[] = [];
  const log = collectingLogger(events);
  const app = new Hono<AuthEnv>();
  // Stand in for authMiddleware: populate authUser for /v1/* routes.
  app.use('/v1/*', async (c, next) => {
    c.set('authUser', {
      id: 'user-1',
      clerkUserId: 'clerk-1',
      phone: '+919000000000',
      displayName: 'Test',
    });
    await next();
  });
  app.use('/v1/*', requestLogger(log));
  app.get('/v1/households/:householdId/chat', (c) => c.json({ ok: true }));

  const res = await app.request('/v1/households/h-123/chat');
  assert.equal(res.status, 200);

  const http = events.find((e) => (e as { msg?: string }).msg === 'http.request') as Record<
    string,
    unknown
  >;
  assert.ok(http, 'http.request log emitted');
  assert.equal(http.method, 'GET');
  assert.equal(http.route, '/v1/households/h-123/chat');
  assert.equal(http.status, 200);
  assert.equal(http.userId, 'user-1');
  assert.equal(http.householdId, 'h-123');
  assert.equal(typeof http.latencyMs, 'number');
});

test('logAuthorizationDenied emits a structured authorization_denied event', () => {
  const events: unknown[] = [];
  const log = collectingLogger(events);
  logAuthorizationDenied(log, {
    userId: 'user-1',
    householdId: 'h-1',
    capability: 'read_chat',
    message: 'not a member',
  });
  const denial = events.find(
    (e) => (e as { msg?: string }).msg === 'authorization_denied',
  ) as Record<string, unknown>;
  assert.ok(denial, 'authorization_denied log emitted');
  assert.equal(denial.userId, 'user-1');
  assert.equal(denial.householdId, 'h-1');
  assert.equal(denial.capability, 'read_chat');
});
