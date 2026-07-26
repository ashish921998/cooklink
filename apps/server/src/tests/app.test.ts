import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

test('health route is public JSON', async () => {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, service: 'cooklink-server' }));

  const res = await app.request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'cooklink-server' });
});
