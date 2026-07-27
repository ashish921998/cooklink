import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { Scheduler, JOB_INTERVALS, createScheduler } from '../scheduler.js';

/**
 * Scheduler unit tests (issue 07, AC#17). These verify registration, the
 * no-faster-than-10s order-tracking cadence, and `runOnce` dispatch without
 * touching MySQL. The Drizzle-backed job bodies are exercised by the MySQL
 * integration tests in `jobs.routes.test.ts`.
 */

const silentLogger = pino({ level: 'silent' });

test('createScheduler registers all six V1 jobs', () => {
  const fakeDb = {} as never;
  const fakeMedia = {} as never;
  const scheduler = createScheduler(fakeDb, { media: fakeMedia }, silentLogger);
  assert.deepEqual(scheduler.jobNames.sort(), [
    'media_ttl_sweep',
    'order_tracking_poll',
    'push_token_cleanup',
    'suggestion_expiry',
    'swiggy_token_cleanup',
    'tts_ttl_sweep',
  ]);
});

test('order-tracking poll runs no faster than every ten seconds', () => {
  assert.equal(JOB_INTERVALS.orderTrackingPollMs, 10_000);
  assert.ok(JOB_INTERVALS.orderTrackingPollMs >= 10_000, 'track_order cadence must be >= 10s');
});

test('start is idempotent and stop clears the running flag', () => {
  const scheduler = new Scheduler(
    [{ name: 'probe', intervalMs: 1000, run: async () => {} }],
    silentLogger,
  );
  assert.equal(scheduler.isRunning, false);
  scheduler.start();
  assert.equal(scheduler.isRunning, true);
  scheduler.start(); // idempotent
  assert.equal(scheduler.isRunning, true);
  scheduler.stop();
  assert.equal(scheduler.isRunning, false);
});

test('runOnce invokes the named job body once', async () => {
  let calls = 0;
  const scheduler = new Scheduler(
    [
      {
        name: 'probe',
        intervalMs: 1000,
        run: async () => {
          calls++;
        },
      },
    ],
    silentLogger,
  );
  await scheduler.runOnce('probe');
  assert.equal(calls, 1);
});

test('runOnce throws for an unknown job name', async () => {
  const scheduler = new Scheduler([], silentLogger);
  await assert.rejects(() => scheduler.runOnce('nope'), /Unknown scheduled job/);
});

test('a thrown job body is swallowed by runOnce (scheduler never crashes)', async () => {
  const scheduler = new Scheduler(
    [
      {
        name: 'boom',
        intervalMs: 1000,
        run: async () => {
          throw new Error('x');
        },
      },
    ],
    silentLogger,
  );
  await scheduler.runOnce('boom'); // should not reject
  assert.equal(scheduler.isRunning, false);
});
