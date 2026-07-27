import { and, eq, isNotNull, lte, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '@cooklink/db';
import { actionSuggestions, deviceRegistrations, swiggyTokens } from '@cooklink/db';
import type { MediaStore } from './media.js';

/**
 * Scheduled-job implementations (issue 07, AC#17).
 *
 * PlanetScale provides no database scheduler, so these maintenance sweeps run
 * inside the application server's own scheduler loop (`scheduler.ts`). Each
 * job is an idempotent, self-contained function that takes a `now` timestamp
 * and a Pino logger; none of them depend on the Hono request context.
 *
 * Real Swiggy ordering is feature-gated (issue 07, AC#12); until it is
 * enabled, `pollActiveOrders` is a no-op that logs nothing, because there is
 * no MCP client to call and no placed orders to track.
 */

export interface JobResult {
  /** Number of rows affected / items processed; used for log context only. */
  affected: number;
}

export interface OrderTracker {
  /**
   * Poll active (placed, not yet delivered) orders. Returns the number of
   * orders whose status was re-checked. The server-side Swiggy MCP client
   * implements this; the default no-op tracker is used while ordering is
   * feature-gated.
   */
  pollActiveOrders(now: Date): Promise<JobResult>;
}

export interface SchedulerServices {
  media: MediaStore;
  /** Feature-gated; defaults to a no-op while real ordering is disabled. */
  orderTracker?: OrderTracker;
}

/** Expire private suggestions whose 24h window has elapsed (issue 06/07). */
export async function expireStaleSuggestions(
  db: Database,
  now: Date,
  log: Logger,
): Promise<JobResult> {
  const result = await db
    .update(actionSuggestions)
    .set({ status: 'expired' })
    .where(and(eq(actionSuggestions.status, 'pending'), lte(actionSuggestions.expiresAt, now)));
  const affected = Number(result[0]?.affectedRows ?? 0);
  if (affected > 0) log.info({ msg: 'job.suggestions_expired', affected });
  return { affected };
}

/** Delete expired Swiggy OAuth tokens (5-day life per issue 07). */
export async function cleanupExpiredSwiggyTokens(
  db: Database,
  now: Date,
  log: Logger,
): Promise<JobResult> {
  const result = await db.delete(swiggyTokens).where(lte(swiggyTokens.expiresAt, now));
  const affected = Number(result[0]?.affectedRows ?? 0);
  if (affected > 0) log.info({ msg: 'job.swiggy_tokens_removed', affected });
  return { affected };
}

/**
 * Prune stale push tokens. A token is stale once it has been invalidated, or
 * once it has not recorded a successful dispatch in 30 days (issue 07 — stale
 * tokens are pruned). The `device_registrations` table has no `createdAt`, so
 * age is inferred from the last successful dispatch.
 */
export async function cleanupStalePushTokens(
  db: Database,
  now: Date,
  log: Logger,
): Promise<JobResult> {
  const staleCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const result = await db.delete(deviceRegistrations).where(
    or(
      isNotNull(deviceRegistrations.invalidatedAt), // invalidated
      lte(deviceRegistrations.lastSuccessAt, staleCutoff), // not seen in 30d
    ),
  );
  const affected = Number(result[0]?.affectedRows ?? 0);
  if (affected > 0) log.info({ msg: 'job.push_tokens_pruned', affected });
  return { affected };
}

/**
 * Poll active grocery orders for delivery updates. Delegates to the
 * feature-gated order tracker; no-op until real ordering is enabled.
 */
export async function pollActiveOrders(
  _db: Database,
  now: Date,
  log: Logger,
  services: SchedulerServices,
): Promise<JobResult> {
  const tracker = services.orderTracker;
  if (!tracker) return { affected: 0 };
  const result = await tracker.pollActiveOrders(now);
  if (result.affected > 0) log.info({ msg: 'job.orders_polled', affected: result.affected });
  return result;
}

/**
 * Media TTL sweep. V1 retains chat media for the Household's life with no
 * proactive age-out (issue 07, AC#18); the optional `MediaStore.sweepTtl`
 * hook lets a production R2 implementation purge orphaned/expired objects
 * (e.g. generated TTS audio at 90 days). The in-memory store leaves the hook
 * unimplemented, so this job is a no-op until R2 is wired.
 */
export async function sweepMediaTtl(
  _db: Database,
  now: Date,
  log: Logger,
  services: SchedulerServices,
): Promise<JobResult> {
  if (typeof services.media.sweepTtl !== 'function') return { affected: 0 };
  const result = await services.media.sweepTtl(now);
  if (result.affected > 0) log.info({ msg: 'job.media_swept', affected: result.affected });
  return result;
}

/**
 * TTS audio TTL sweep (issue 07, AC#17 — "the R2 media and TTS TTL sweeps").
 * ElevenLabs recipe audio is cached by content key with a 90-day TTL
 * (AC#16/AC#18). ElevenLabs TTS itself is gated to a later slice, so this job
 * is a no-op stub that the scheduler registers now so the cadence exists.
 */
export async function sweepTtsTtl(
  _db: Database,
  _now: Date,
  _log: Logger,
  _services: SchedulerServices,
): Promise<JobResult> {
  // TODO(issue 02/07 AC#16): once ElevenLabs TTS is wired, purge R2 objects
  // whose content key is older than 90 days here.
  return { affected: 0 };
}
