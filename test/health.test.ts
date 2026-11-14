import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createApp } from '../src/http/app.ts';

test('GET /api/health répond ok', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const res = await createApp({ db }).request('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('route API inconnue → 404 JSON', async () => {
  const res = await createApp({ db: openDb(':memory:') }).request('/api/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('la page d\'accueil est servie', async () => {
  const res = await createApp({ db: openDb(':memory:') }).request('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>/);
});
