import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { Database } from '@cooklink/db';
import { waitlistEntries } from '@cooklink/db';
import type { AuthEnv } from '../auth.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const allowedSources = new Set(['landing', 'landing-v2']);
const maxBodyBytes = 4_096;
const defaultRateLimit = 10;
const defaultRateWindowMs = 60 * 60 * 1_000;
const maxTrackedClients = 10_000;

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface WaitlistRouteOptions {
  now?: () => number;
  rateLimit?: number;
  rateWindowMs?: number;
}

interface RateWindow {
  count: number;
  startedAt: number;
}

export function registerWaitlistRoutes(
  app: Hono<AuthEnv>,
  db: Database,
  options: WaitlistRouteOptions = {},
): void {
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimit ?? defaultRateLimit;
  const rateWindowMs = options.rateWindowMs ?? defaultRateWindowMs;
  const clients = new Map<string, RateWindow>();

  app.post('/waitlist', async (c) => {
    const declaredLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return c.json({ error: 'payload_too_large' }, 413);
    }

    let payload: { email?: unknown; source?: unknown; website?: unknown };
    try {
      const raw = await c.req.text();
      if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) {
        return c.json({ error: 'payload_too_large' }, 413);
      }
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // A hidden field catches basic form bots. Return success without writing
    // so automated clients cannot use the response to tune around the trap.
    if (typeof payload.website === 'string' && payload.website.trim()) {
      return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!emailPattern.test(email) || email.length > 320) {
      return c.json({ error: 'valid_email_required' }, 400);
    }

    const clientKey = c.req.header('x-real-ip')?.trim() || 'unknown';
    const rate = consumeRateLimit(clients, clientKey, now(), rateLimit, rateWindowMs);
    c.header('RateLimit-Limit', String(rate.limit));
    c.header('RateLimit-Remaining', String(rate.remaining));
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'rate_limited' }, 429, { 'Cache-Control': 'no-store' });
    }

    const source =
      typeof payload.source === 'string' && allowedSources.has(payload.source)
        ? payload.source
        : 'landing';

    await db
      .insert(waitlistEntries)
      .values({ id: randomUUID(), email, source })
      .onConflictDoNothing({ target: waitlistEntries.email });

    return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
  });
}

function consumeRateLimit(
  clients: Map<string, RateWindow>,
  clientKey: string,
  timestamp: number,
  limit: number,
  windowMs: number,
): RateLimitResult {
  let window = clients.get(clientKey);
  if (!window || timestamp - window.startedAt >= windowMs) {
    if (!window && clients.size >= maxTrackedClients) pruneClients(clients, timestamp, windowMs);
    window = { count: 0, startedAt: timestamp };
    clients.set(clientKey, window);
  }

  window.count += 1;
  const allowed = window.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - window.count),
    retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - timestamp) / 1_000)),
  };
}

function pruneClients(clients: Map<string, RateWindow>, timestamp: number, windowMs: number): void {
  for (const [key, window] of clients) {
    if (timestamp - window.startedAt >= windowMs) clients.delete(key);
  }
  if (clients.size >= maxTrackedClients) {
    const oldest = clients.keys().next().value as string | undefined;
    if (oldest) clients.delete(oldest);
  }
}
