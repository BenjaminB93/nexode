import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/db/index.ts';
import type { Catalog } from '../src/ports.ts';
import { dailyMaintenance, describePurge, purgeExpired, refreshTrackedShows } from '../src/usecases/refresh.ts';
import { addUser } from './helpers/auth.ts';
import { seedShow, testDb } from './helpers/fake-catalog.ts';

const NOW = new Date('2026-11-14T03:30:00.000Z');

// Catalogue qui note les rafraîchissements ; failIds échouent.
function recordingCatalog(failIds: number[] = []) {
  const refreshed: number[] = [];
  const catalog: Catalog = {
    ensureShow: async () => assert.fail('ensureShow inattendu'),
    ensureProviders: async () => assert.fail('ensureProviders inattendu'),
    regions: async () => assert.fail('regions inattendu'),
    searchShows: async () => assert.fail('searchShows inattendu'),
    findShowByTvdb: async () => assert.fail('findShowByTvdb inattendu'),
    findEpisodeByTvdb: async () => assert.fail('findEpisodeByTvdb inattendu'),
    async refreshShow(id) {
      refreshed.push(id);
      if (failIds.includes(id)) throw new Error(`TMDB 500 sur /tv/${id}`);
    },
  };
  return { catalog, refreshed };
}

function seed(db: Db) {
  for (const id of [10, 20, 30, 40]) seedShow(db, { id, name: `Série ${id}`, seasons: [['2026-01-01']] });
  const a = addUser(db, 'alice');
  const b = addUser(db, 'bob');
  const follow = db.prepare("INSERT INTO user_shows (user_id, show_id, state, added_at) VALUES (?, ?, ?, '2026-11-01T00:00:00.000Z')");
  follow.run(a, 30, 'followed');
  follow.run(a, 10, 'shelved');
  follow.run(b, 30, 'shelved');
  follow.run(b, 20, 'followed');
  // 40 : en cache (vue par quelqu'un, plus suivie) mais absente de user_shows.
  return { a, b };
}

test('rafraîchit chaque série suivie ou de côté, une seule fois, avec une pause entre deux', async () => {
  const db = testDb();
  seed(db);
  const { catalog, refreshed } = recordingCatalog();
  const events: string[] = [];
  const r = await refreshTrackedShows({
    db, catalog, pauseMs: 250,
    sleep: async (ms) => void events.push(`pause ${ms}`),
    warn: (m) => assert.fail(m),
  });
  assert.deepEqual(refreshed, [10, 20, 30]);
  assert.deepEqual(events, ['pause 250', 'pause 250']);
  assert.deepEqual(r, { total: 3, refreshed: 3, failed: 0, aborted: false });
});

test('continue après une série en échec et journalise id et message', async () => {
  const db = testDb();
  seed(db);
  const { catalog, refreshed } = recordingCatalog([20]);
  const warnings: string[] = [];
  const r = await refreshTrackedShows({ db, catalog, sleep: async () => {}, warn: (m) => void warnings.push(m) });
  assert.deepEqual(refreshed, [10, 20, 30]);
  assert.deepEqual(r, { total: 3, refreshed: 2, failed: 1, aborted: false });
  assert.deepEqual(warnings, ['rafraîchissement de la série 20 en échec : TMDB 500 sur /tv/20']);
});

test('s’arrête entre deux séries quand le signal est abandonné', async () => {
  const db = testDb();
  seed(db);
  const { catalog, refreshed } = recordingCatalog();
  const ac = new AbortController();
  const r = await refreshTrackedShows({
    db, catalog, signal: ac.signal,
    sleep: async () => ac.abort(),
    warn: (m) => assert.fail(m),
  });
  assert.deepEqual(refreshed, [10]);
  assert.deepEqual(r, { total: 3, refreshed: 1, failed: 0, aborted: true });
});

test('pause par défaut réelle et interrompue par l’abandon', async () => {
  const db = testDb();
  seed(db);
  const { catalog, refreshed } = recordingCatalog();
  const ac = new AbortController();
  const started = Date.now();
  const p = refreshTrackedShows({ db, catalog, signal: ac.signal, pauseMs: 60_000, warn: (m) => assert.fail(m) });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(refreshed, [10]);
  assert.equal(r.aborted, true);
});

test('purge : sessions expirées, liens expirés ou utilisés depuis plus de 30 jours', () => {
  const db = testDb();
  const { a, b } = seed(db);
  const session = db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')");
  session.run('s-expiree', a, '2026-11-14T03:29:59.999Z');
  session.run('s-pile', a, '2026-11-14T03:30:00.000Z');          // expires_at <= now : expirée
  session.run('s-valide', b, '2026-11-14T03:30:00.001Z');
  const reset = db.prepare('INSERT INTO reset_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)');
  // Limite : 2026-10-15T03:30:00.000Z.
  reset.run('r-expire-vieux', a, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', null);
  reset.run('r-utilise-vieux', a, '2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z', '2026-10-14T01:00:00.000Z');
  reset.run('r-expire-recent', b, '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z', null);
  reset.run('r-utilise-recent', b, '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z', '2026-10-20T01:00:00.000Z');
  reset.run('r-valide', b, '2026-11-14T00:00:00.000Z', '2026-11-15T00:00:00.000Z', null);

  assert.equal(purgeExpired(db, NOW), 2);
  const left = (table: string) => (db.prepare(`SELECT token_hash FROM ${table} ORDER BY token_hash`).all() as { token_hash: string }[]).map((r) => r.token_hash);
  assert.deepEqual(left('sessions'), ['s-valide']);
  assert.deepEqual(left('reset_tokens'), ['r-expire-recent', 'r-utilise-recent', 'r-valide']);
});

test('maintenance : purge puis rafraîchissement ; sans catalogue (pas de jeton), purge seule', async () => {
  const db = testDb();
  const { a } = seed(db);
  const addExpired = () => db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('vieille', ?, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(a);
  const count = () => (db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;

  addExpired();
  const { catalog, refreshed } = recordingCatalog();
  const r = await dailyMaintenance({ db, catalog, now: () => NOW, sleep: async () => {}, warn: (m) => assert.fail(m) });
  assert.equal(count(), 0);
  assert.deepEqual(refreshed, [10, 20, 30]);
  assert.deepEqual(r, { purgedResets: 0, refresh: { total: 3, refreshed: 3, failed: 0, aborted: false } });

  addExpired();
  const offline = await dailyMaintenance({ db, catalog: undefined, now: () => NOW });
  assert.equal(count(), 0);
  assert.deepEqual(offline, { purgedResets: 0, refresh: null });
});

test('maintenance : une purge en échec (base verrouillée) n’empêche pas le rafraîchissement', async () => {
  const db = testDb();
  const { a } = seed(db);
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('vieille', ?, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(a);
  db.exec("CREATE TEMP TRIGGER verrou BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
  const { catalog, refreshed } = recordingCatalog();
  const warnings: string[] = [];
  const r = await dailyMaintenance({ db, catalog, now: () => NOW, sleep: async () => {}, warn: (m) => void warnings.push(m) });
  assert.deepEqual(refreshed, [10, 20, 30]);
  assert.deepEqual(r, { purgedResets: null, refresh: { total: 3, refreshed: 3, failed: 0, aborted: false } });
  assert.deepEqual(warnings, ['purge en échec : database is locked']);
  assert.equal(describePurge(r.purgedResets), 'purge en échec');
});
