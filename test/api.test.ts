import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.ts';
import { type ShowFixture, FakeCatalog, epId, seedShow, testDb } from './helpers/fake-catalog.ts';

const NOW = '2026-11-13T12:00:00.000Z';
const SEV: ShowFixture = {
  id: 1001, name: 'Severance',
  seasons: [['2026-10-01', '2026-10-08', '2026-10-15'], ['2026-11-13', '2026-11-20']],
  providers: { FR: [[350], [350]] },
};
const FINIE: ShowFixture = { id: 1002, name: 'Finie', status: 'ended', seasons: [['2025-01-01', '2025-01-08']] };

function setup(opts: { devUser?: boolean; withCatalog?: boolean } = {}) {
  const db = testDb();
  const catalog = new FakeCatalog(db, [SEV, FINIE]);
  let now = new Date(NOW);
  const app = createApp({ db, catalog: opts.withCatalog === false ? undefined : catalog, devUser: opts.devUser ?? true, now: () => now });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, catalog, app, call, setNow: (iso: string) => { now = new Date(iso); } };
}

test('sans devUser : 401 partout sauf /api/health', async () => {
  const { call } = setup({ devUser: false });
  assert.equal((await call('GET', '/api/health')).status, 200);
  for (const [m, p] of [['GET', '/api/timeline'], ['GET', '/api/shows/1001'], ['PUT', '/api/watched/1']] as const) {
    const r = await call(m, p, m === 'PUT' ? {} : undefined);
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.deepEqual(r.body, { error: 'unauthorized' });
  }
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('parcours complet : recherche, suivre, timeline, vu, annuler, historique', async () => {
  const { call } = setup();
  const s = await call('GET', '/api/search?q=sev');
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.results.map((r: any) => [r.id, r.relation, r.cached]), [[1001, 'none', false]]);

  const rel = await call('PUT', '/api/shows/1001/relation', { to: 'on' });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.show.relation, 'on');
  assert.equal(rel.body.show.status, 'encours');
  assert.equal(rel.body.show.next.id, epId(1001, 1, 1));

  const tl = await call('GET', '/api/timeline');
  assert.equal(tl.body.today, '2026-11-13');
  assert.deepEqual(tl.body.toWatch.map((x: any) => [x.show.name, x.next.number, x.remaining]), [['Severance', 1, 4]]);
  assert.deepEqual(tl.body.upcoming.map((x: any) => x.episode.id), [epId(1001, 2, 2)]);

  const e1 = epId(1001, 1, 1);
  const w = await call('PUT', `/api/watched/${e1}`, {});
  assert.deepEqual(w.body.marked, [e1]);
  assert.equal(w.body.show.next.id, epId(1001, 1, 2));
  assert.equal(w.body.show.seen, 1);
  assert.deepEqual((await call('PUT', `/api/watched/${e1}`, {})).body.marked, []);

  const del = await call('DELETE', `/api/watched/${e1}`);
  assert.deepEqual(del.body.removed, [{ episodeId: e1, watchedAt: NOW }]);
  assert.equal(del.body.show.seen, 0);
  const undo = await call('PUT', `/api/watched/${e1}`, { watchedAt: del.body.removed[0].watchedAt });
  assert.deepEqual(undo.body.marked, [e1]);

  const h = await call('GET', '/api/history');
  assert.deepEqual(h.body.items.map((i: any) => [i.episodeId, i.watchedAt, i.watchedDay, i.show.name]), [[e1, NOW, '2026-11-13', 'Severance']]);
  assert.equal(h.body.next, null);
});

test('lots, tout vu jusqu\'ici, saison, De côté, Mes séries, fiches', async () => {
  const { call, setNow } = setup();
  await call('PUT', '/api/shows/1001/relation', { to: 'on' });
  const until = await call('POST', '/api/shows/1001/watched-until', { episodeId: epId(1001, 1, 2) });
  assert.deepEqual(until.body.marked, [epId(1001, 1, 1), epId(1001, 1, 2)]);
  assert.equal(until.body.show.next.id, epId(1001, 1, 3));

  const off = await call('POST', '/api/watched/batch', { on: false, episodeIds: [epId(1001, 1, 1), epId(1001, 1, 2)] });
  assert.equal(off.body.removed.length, 2);
  assert.equal(off.body.shows[0].seen, 0);
  const back = await call('POST', '/api/watched/batch', { on: true, restore: off.body.removed });
  assert.deepEqual(back.body.marked.sort(), [epId(1001, 1, 1), epId(1001, 1, 2)]);

  const season = await call('POST', '/api/shows/1001/seasons/1/watched', {});
  assert.deepEqual(season.body.marked, [epId(1001, 1, 3)]);

  const batch = await call('POST', '/api/watched/batch', { on: true, episodeIds: [epId(1001, 2, 1)], watchedAt: '2026-11-13T10:00:00+01:00' });
  assert.deepEqual(batch.body.marked, [epId(1001, 2, 1)]);
  assert.equal(batch.body.shows[0].status, 'ajour');

  await call('PUT', '/api/shows/1002/relation', { to: 'shelf' });
  const shelf = await call('GET', '/api/shelf');
  assert.deepEqual(shelf.body.notStarted.map((c: any) => [c.show.id, c.reason.kind, c.remaining]), [[1002, 'manual', 2]]);
  assert.deepEqual(shelf.body.abandoned, []);

  const mine = await call('GET', '/api/my-shows');
  assert.deepEqual(mine.body.shows.map((r: any) => [r.name, r.relation, r.seen, r.total]), [['Finie', 'shelf', 0, 2], ['Severance', 'on', 4, 5]]);

  const detail = await call('GET', '/api/shows/1001');
  assert.equal(detail.body.status, 'ajour');
  assert.equal(detail.body.wouldBeStatus, 'ajour');
  assert.deepEqual(detail.body.providers, { country: 'FR', groups: [{ from: 1, to: 2, label: null, items: [{ id: 350, name: 'Plateforme 350', logoPath: '/l350.png' }] }] });
  assert.deepEqual(detail.body.seasons.map((s: any) => [s.number, s.seen, s.aired, s.count]), [[1, 3, 3, 3], [2, 1, 1, 2]]);

  const s2 = await call('GET', '/api/shows/1001/seasons/2');
  assert.deepEqual(s2.body.episodes.map((e: any) => [e.number, e.aired, e.watchedAt]), [[1, true, '2026-11-13T09:00:00.000Z'], [2, false, null]]);

  // Une semaine plus tard, S2E2 est sorti : la série repasse « en cours ».
  setNow('2026-11-20T08:00:00.000Z');
  assert.deepEqual((await call('GET', '/api/timeline')).body.toWatch.map((x: any) => x.next.id), [epId(1001, 2, 2)]);
});

test('validation stricte des entrées → 400', async () => {
  const { call } = setup();
  const bad = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await call(method, path, body, headers);
    assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    return r.body;
  };
  assert.deepEqual(await bad('GET', '/api/shows/abc'), { error: 'invalid_input', field: 'id' });
  await bad('GET', '/api/shows/0');
  await bad('GET', '/api/shows/-3');
  await bad('GET', '/api/shows/1.5');
  await bad('GET', '/api/shows/1001/seasons/0');
  assert.deepEqual(await bad('PUT', '/api/shows/1001/relation', { to: 'x' }), { error: 'invalid_input', field: 'to' });
  await bad('PUT', '/api/shows/1001/relation', {});
  assert.deepEqual(await bad('PUT', '/api/shows/1001/relation', { to: 'on', extra: 1 }), { error: 'invalid_input', field: 'extra' });
  assert.deepEqual(await bad('PUT', '/api/shows/1001/relation', '{"to":"on"}', { 'content-type': 'text/plain' }), { error: 'json_required' });
  assert.deepEqual(await bad('PUT', '/api/shows/1001/relation', '{to', {}), { error: 'invalid_json' });
  await bad('PUT', '/api/shows/1001/relation', '[1]');
  await bad('POST', '/api/shows/1001/seasons/1/watched', undefined);   // pas de corps JSON
  await bad('PUT', '/api/watched/1001101', { watchedAt: '2026-11-13' });
  await bad('PUT', '/api/watched/1001101', { watchedAt: '2027-01-01T00:00:00Z' });   // futur
  await bad('POST', '/api/watched/batch', { on: true, episodeIds: ['1001101'] });
  await bad('POST', '/api/watched/batch', { on: true, episodeIds: [] });
  await bad('POST', '/api/watched/batch', { on: 'oui', episodeIds: [1001101] });
  await bad('POST', '/api/watched/batch', { on: false, episodeIds: [1001101], watchedAt: NOW });
  await bad('POST', '/api/watched/batch', { on: true, restore: [{ episodeId: 1001101 }] });
  await bad('POST', '/api/shows/1001/watched-until', { episodeId: '1001101' });
  await bad('GET', '/api/history?limit=0');
  await bad('GET', '/api/history?limit=101');
  await bad('GET', '/api/history?before=nimportequoi');
  await bad('GET', '/api/search?q=');
  await bad('GET', '/api/search?q=%20%20');
});

test('inconnu → 404, pas sorti → 409, catalogue absent → 502', async () => {
  const { call, db } = setup();
  assert.deepEqual((await call('GET', '/api/shows/4242')).body, { error: 'not_found' });
  assert.equal((await call('PUT', '/api/watched/999', {})).status, 404);
  assert.equal((await call('DELETE', '/api/watched/999')).status, 404);
  await call('GET', '/api/shows/1001');
  assert.equal((await call('GET', '/api/shows/1001/seasons/7')).status, 404);
  assert.equal((await call('POST', '/api/shows/1001/watched-until', { episodeId: epId(1002, 1, 1) })).status, 404);
  const r = await call('PUT', `/api/watched/${epId(1001, 2, 2)}`, {});
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'not_aired' });
  void db;

  const off = setup({ withCatalog: false });
  assert.deepEqual(await off.call('GET', '/api/shows/1001'), { status: 502, body: { error: 'catalog_unavailable' } });
  assert.equal((await off.call('GET', '/api/search?q=sev')).status, 502);
  // Les lectures en cache marchent sans catalogue.
  seedShow(off.db, SEV);
  assert.equal((await off.call('GET', '/api/shows/1001')).status, 200);
  assert.equal((await off.call('GET', '/api/timeline')).status, 200);
});

test('tout vu jusqu\'ici sur plus de 1000 épisodes, puis annulation', async () => {
  const { db, call } = setup();
  const LONG = 1009;
  seedShow(db, { id: LONG, name: 'Très longue', seasons: Array.from({ length: 12 }, () => Array.from({ length: 100 }, () => '2020-01-01')) });
  const last = epId(LONG, 12, 100);
  const r = await call('POST', `/api/shows/${LONG}/watched-until`, { episodeId: last });
  assert.equal(r.status, 200);
  assert.equal(r.body.marked.length, 1200);
  const undo = await call('POST', '/api/watched/batch', { on: false, episodeIds: r.body.marked });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.removed.length, 1200);
  const tooMany = await call('POST', '/api/watched/batch', { on: false, episodeIds: Array.from({ length: 10_001 }, (_, i) => i + 1) });
  assert.equal(tooMany.status, 400);
});

test('corps trop gros → 413', async () => {
  const { call } = setup();
  const big = JSON.stringify({ watchedAt: 'x'.repeat(2 * 1024 * 1024) });
  const r = await call('PUT', `/api/watched/${epId(1001, 1, 1)}`, big);
  assert.equal(r.status, 413);
  assert.deepEqual(r.body, { error: 'payload_too_large' });
});
