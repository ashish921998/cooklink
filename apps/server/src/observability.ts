import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Error capture (issue 07, AC#19) — Sentry / Glitchtip ingest, zero-dependency.
 *
 * Glitchtip speaks the Sentry envelope protocol, so a single minimal sender
 * covers both hosted Sentry and a self-hosted Glitchtip server. It is
 * initialized only when `SENTRY_DSN` is present in the server environment;
 * with no DSN — the default for local dev and tests — every call is a no-op,
 * so the test suite never needs a network or a configured project.
 *
 * The heavy `@sentry/node` SDK was deliberately avoided: its OpenTelemetry
 * transitive dependency created a second `drizzle-orm` install in the pnpm
 * store and broke type identity across the server. This sender is a few dozen
 * lines and posts envelopes over the same public protocol.
 */

interface ParsedDsn {
  publicKey: string;
  secretKey?: string;
  projectId: string;
  host: string;
  protocol: 'https:' | 'http:';
}

let dsn: ParsedDsn | null = null;
let release: string | undefined;

/** Initialize the error-capture sender if a DSN is configured; else no-op. */
export function initObservability(): void {
  const raw = process.env.SENTRY_DSN;
  if (!raw) return;
  const parsed = parseDsn(raw);
  if (!parsed) return;
  dsn = parsed;
  release = process.env.SENTRY_RELEASE;
}

/** Capture an exception, with optional structured context. No-op without DSN. */
export function captureError(err: unknown, context?: Record<string, unknown>): string | null {
  if (!dsn) return null;
  const eventId = randomUUID().replace(/-/g, '');
  const envelope = buildExceptionEnvelope(err, eventId, context);
  send(envelope).catch(() => {
    // Best-effort; ingest failures must never break the request path.
  });
  return eventId;
}

/** Flush is a no-op here (envelopes are sent fire-and-forget). */
export async function flushObservability(): Promise<void> {
  // The minimal sender posts envelopes synchronously to the ingest endpoint;
  // there is no buffered transport to flush.
}

function parseDsn(raw: string): ParsedDsn | null {
  try {
    const u = new URL(raw);
    const publicKey = u.username;
    const secretKey = u.password || undefined;
    const projectId = u.pathname.replace(/^\//, '');
    if (!publicKey || !projectId) return null;
    return {
      publicKey,
      secretKey,
      projectId,
      host: u.host,
      protocol: u.protocol as 'https:' | 'http:',
    };
  } catch {
    return null;
  }
}

function buildExceptionEnvelope(
  err: unknown,
  eventId: string,
  context?: Record<string, unknown>,
): string {
  const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: 'event' });
  const event = JSON.stringify({
    event_id: eventId,
    timestamp: new Date().toISOString(),
    level: 'error',
    platform: 'node',
    release,
    server_name: process.env.HOSTNAME ?? undefined,
    message: err instanceof Error ? err.message : String(err),
    exception: {
      values: [
        {
          type: err instanceof Error ? err.name : 'Error',
          value: err instanceof Error ? err.message : String(err),
          stacktrace: err instanceof Error ? { frames: toFrames(err) } : undefined,
        },
      ],
    },
    extra: context,
  });
  return `${header}\n${itemHeader}\n${event}`;
}

function toFrames(
  err: Error,
): { filename: string; function: string; lineno: number; colno: number }[] {
  return (err.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .map((line) => {
      const match = /at (?:(.+) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
      if (!match) return null;
      return {
        filename: match[2] ?? '',
        function: match[1] ?? '<anonymous>',
        lineno: Number(match[3] ?? 0),
        colno: Number(match[4] ?? 0),
      };
    })
    .filter(
      (f): f is { filename: string; function: string; lineno: number; colno: number } => f !== null,
    )
    .reverse();
}

function send(envelope: string): Promise<void> {
  if (!dsn) return Promise.resolve();
  const path = `/api/${dsn.projectId}/envelope/`;
  const auth = `Sentry sentry_key=${dsn.publicKey}${dsn.secretKey ? `, sentry_secret=${dsn.secretKey}` : ''}, sentry_version=7`;
  const body = Buffer.from(envelope);
  const options = {
    method: 'POST',
    hostname: dsn.host,
    path,
    protocol: dsn.protocol,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'X-Sentry-Auth': auth,
    },
  };
  const req = (dsn.protocol === 'https:' ? request : httpRequest)(options);
  return new Promise<void>((resolve) => {
    req.on('error', () => resolve());
    req.on('response', () => resolve());
    req.write(body);
    req.end();
  });
}
