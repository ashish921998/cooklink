import type { Logger } from 'pino';
import type { Database } from '@cooklink/db';
import {
  cleanupExpiredSwiggyTokens,
  cleanupStalePushTokens,
  expireStaleSuggestions,
  pollActiveOrders,
  sweepMediaTtl,
  sweepTtsTtl,
  type SchedulerServices,
} from './jobs.js';
import { captureError } from './observability.js';

/**
 * The in-process scheduler (issue 07, AC#17).
 *
 * PlanetScale provides no database scheduler, so the always-on Hono server
 * runs a single `setInterval` loop per job. Each job is registered with a
 * minimum interval and a run function; `start()` schedules them and `stop()`
 * clears every handle. The active-order tracking poll runs no faster than
 * every ten seconds, per the Swiggy MCP contract in issue 01/07.
 */

export interface ScheduledJob {
  name: string;
  /** Minimum spacing between runs in milliseconds. */
  intervalMs: number;
  run: () => Promise<unknown>;
}

/** Default cadences (issue 07, AC#17). */
export const JOB_INTERVALS = {
  orderTrackingPollMs: 10_000,
  swiggyTokenCleanupMs: 60 * 60 * 1000, // 1h
  pushTokenCleanupMs: 6 * 60 * 60 * 1000, // 6h
  suggestionExpiryMs: 5 * 60 * 1000, // 5m
  mediaTtlSweepMs: 24 * 60 * 60 * 1000, // 24h
  ttsTtlSweepMs: 24 * 60 * 60 * 1000, // 24h
} as const;

export class Scheduler {
  private readonly handles = new Set<ReturnType<typeof setInterval>>();
  private running = false;

  constructor(
    private readonly jobs: ScheduledJob[],
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const job of this.jobs) {
      this.log.info({
        msg: 'scheduler.job_registered',
        name: job.name,
        intervalMs: job.intervalMs,
      });
      const handle = setInterval(() => {
        this.tick(job).catch((err) =>
          this.log.error({ msg: 'scheduler.tick_failed', name: job.name, err }),
        );
      }, job.intervalMs);
      // Don't keep the Node process alive solely for the scheduler in tests.
      handle.unref?.();
      this.handles.add(handle);
    }
  }

  private async tick(job: ScheduledJob): Promise<void> {
    const start = Date.now();
    try {
      await job.run();
      this.log.debug({ msg: 'scheduler.job_ran', name: job.name, durationMs: Date.now() - start });
    } catch (err) {
      this.log.error({ msg: 'scheduler.job_failed', name: job.name, err });
      captureError(err, { job: job.name });
    }
  }

  stop(): void {
    for (const handle of this.handles) clearInterval(handle);
    this.handles.clear();
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Exposed for tests: run a job's body once, immediately. */
  async runOnce(name: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.name === name);
    if (!job) throw new Error(`Unknown scheduled job: ${name}`);
    await this.tick(job);
  }

  /** Exposed for tests: the registered job names. */
  get jobNames(): string[] {
    return this.jobs.map((job) => job.name);
  }
}

/**
 * Build the production scheduler with all V1 jobs wired to the Drizzle
 * database and media store. The order-tracking poll is feature-gated: without
 * an `orderTracker` in `services` it registers but is a no-op, so the
 * scheduler is safe to start before Swiggy production access is granted.
 */
export function createScheduler(
  db: Database,
  services: SchedulerServices,
  log: Logger,
  intervals: Partial<typeof JOB_INTERVALS> = {},
): Scheduler {
  const i = { ...JOB_INTERVALS, ...intervals };
  const now = () => new Date();

  const jobs: ScheduledJob[] = [
    {
      name: 'order_tracking_poll',
      intervalMs: i.orderTrackingPollMs,
      run: () => pollActiveOrders(db, now(), log, services),
    },
    {
      name: 'swiggy_token_cleanup',
      intervalMs: i.swiggyTokenCleanupMs,
      run: () => cleanupExpiredSwiggyTokens(db, now(), log),
    },
    {
      name: 'push_token_cleanup',
      intervalMs: i.pushTokenCleanupMs,
      run: () => cleanupStalePushTokens(db, now(), log),
    },
    {
      name: 'suggestion_expiry',
      intervalMs: i.suggestionExpiryMs,
      run: () => expireStaleSuggestions(db, now(), log),
    },
    {
      name: 'media_ttl_sweep',
      intervalMs: i.mediaTtlSweepMs,
      run: () => sweepMediaTtl(db, now(), log, services),
    },
    {
      name: 'tts_ttl_sweep',
      intervalMs: i.ttsTtlSweepMs,
      run: () => sweepTtsTtl(db, now(), log, services),
    },
  ];

  return new Scheduler(jobs, log);
}
