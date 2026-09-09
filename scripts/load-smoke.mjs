import { performance } from 'node:perf_hooks';

const target = process.argv[2] ?? 'http://localhost:3000/health';
const requestCount = positiveInteger(process.argv[3], 1_000);
const concurrency = Math.min(positiveInteger(process.argv[4], 25), requestCount);
const timeoutMs = positiveInteger(process.env.LOAD_TIMEOUT_MS, 10_000);
const durations = [];
const statuses = new Map();
let cursor = 0;

async function worker() {
  while (cursor < requestCount) {
    cursor += 1;
    const startedAt = performance.now();
    let status = 0;
    try {
      const response = await globalThis.fetch(target, {
        signal: globalThis.AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch {
      status = 0;
    }
    durations.push(performance.now() - startedAt);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedMs = performance.now() - startedAt;
durations.sort((a, b) => a - b);
const successful = [...statuses.entries()]
  .filter(([status]) => status >= 200 && status < 400)
  .reduce((sum, [, count]) => sum + count, 0);
const result = {
  target,
  requests: requestCount,
  concurrency,
  requestsPerSecond: round((requestCount / elapsedMs) * 1_000),
  successRate: round((successful / requestCount) * 100),
  latencyMs: {
    p50: round(percentile(50)),
    p95: round(percentile(95)),
    p99: round(percentile(99)),
    max: round(durations.at(-1) ?? 0),
  },
  statuses: Object.fromEntries([...statuses.entries()].sort(([a], [b]) => a - b)),
};

console.log(JSON.stringify(result, null, 2));
if (successful !== requestCount) process.exitCode = 1;

function percentile(value) {
  const index = Math.min(durations.length - 1, Math.ceil((value / 100) * durations.length) - 1);
  return durations[Math.max(0, index)] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
