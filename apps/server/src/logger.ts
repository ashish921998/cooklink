import type { MiddlewareHandler } from 'hono';
import pino, { type Logger } from 'pino';
import type { AuthEnv } from './auth.js';

/**
 * Structured logging (issue 07, AC#19).
 *
 * Pino emits one JSON object per line to stdout — the host log stream. Every
 * request logs user, Household, route, latency, and status; authorization
 * denials are logged as structured `authorization_denied` events rather than
 * free-text console output. No separate log platform is used at V1.
 */

/**
 * Resolve the process-wide Pino logger. Production drains newline-delimited
 * JSON to stdout; `LOG_LEVEL` controls verbosity.
 */
export function createLogger(): Logger {
  return pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'cooklink-server' } });
}

/**
 * Hono middleware: emit one structured `http.request` log per request with
 * method, route, status, latency (ms), and — when available — the
 * authenticated user and the Household path parameter. Runs after the auth
 * middleware so `authUser` is populated for `/v1/*` routes.
 */
export function requestLogger(logger: Logger): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const latencyMs = Date.now() - start;
    const status = c.res.status;
    const authUser = c.get('authUser');
    const householdId = c.req.param('householdId');
    logger.info({
      msg: 'http.request',
      method: c.req.method,
      route: c.req.path,
      status,
      latencyMs,
      userId: authUser?.id ?? null,
      clerkUserId: authUser?.clerkUserId ?? null,
      householdId: householdId ?? null,
    });
  };
}

/** Structured authorization-denial log (issue 07, AC#5 / AC#19). */
export function logAuthorizationDenied(
  logger: Logger,
  detail: {
    userId?: string;
    householdId?: string;
    capability?: string;
    message: string;
  },
): void {
  logger.warn({ msg: 'authorization_denied', ...detail });
}
