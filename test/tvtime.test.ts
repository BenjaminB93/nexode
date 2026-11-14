import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TvTimeFormatError, parseCsv, parseTvTime } from '../src/domain/tvtime.ts';
import { importTvTime } from '../src/usecases/import-tvtime.ts';
import type { Tmdb } from '../src/infra/tmdb.ts';
import { FakeCatalog, epId, testDb } from './helpers/fake-catalog.ts';
import { addUser } from './helpers/auth.ts';

const HEADER = 'runtime,ep_no,ep_id,key,s_id,user_id,s_no,created_at,gsi,updated_at,total_series_runtime,ep_watch_count,movie_watch_count,total_movies_runtime,series_follow_count,is_followed,followed_at,is_archived,most_recent_ep_watched,uuid,is_for_later,bulk_type,is_unitary,rewatch_count,is_special,movie_name,series_name,season_number,episode_number';

// Ligne de visionnage (29 colonnes, celles qui comptent seulement).
function watch(kind: 'watch' | 'rewatch', sId: number, epTvdb: number, s: number, e: number, at: string, name: string, special = ''): string {
  const c = Array<string>(29).fill('');
  c[1] = String(e); c[2] = String(epTvdb); c[3] = `${kind}-episode-x-${sId}-${s}-${e}-${at}`; c[4] = String(sId); c[6] = String(s); c[7] = at;
  c[24] = special; c[26] = name.includes(',') ? `"${name}"` : name; c[27] = String(s); c[28] = String(e);
  return c.join(',');
}
function series(sId: number, name: string, o: { followed: boolean; archived?: boolean; forLater?: boolean; followedAt?: string; createdAt?: string }): string {
  const c = Array<string>(29).fill('');
  c[3] = `user-series-${sId}`; c[4] = String(sId); c[7] = o.createdAt ?? '2024-01-01 10:00:00'; c[15] = String(o.followed); c[16] = o.followedAt ?? '';
  c[17] = String(!!o.archived); c[18] = '"map[ep_id:1 ep_no:1]"'; c[20] = String(!!o.forLater); c[26] = name.includes(',') ? `"${name}"` : name;
  return c.join(',');
}

test('parseCsv : guillemets, guillemets doublés, virgules et retours à la ligne dans un champ, CRLF', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e"""\r\n"f\ng",h\n'), [['a', 'b, c', 'd "e"'], ['f\ng', 'h']]);
});

test('parseTvTime : premier visionnage gardé, spéciaux ignorés, états de suivi, dates UTC', () => {
  const csv = [HEADER,
    watch('watch', 10, 501, 1, 1, '2024-02-01 20:00:00', 'Love, Death & Robots'),
    watch('rewatch', 10, 501, 1, 1, '2024-01-15 21:30:00', 'Love, Death & Robots'),
    watch('watch', 10, 502, 1, 2, '2024-02-02 20:00:00', 'Love, Death & Robots'),
    watch('watch', 10, 590, 0, 1, '2024-02-03 20:00:00', 'Love, Death & Robots'),
    watch('watch', 10, 591, 2, 1, '2024-02-04 20:00:00', 'Love, Death & Robots', 'true'),
    series(10, 'Love, Death & Robots', { followed: true, followedAt: '1706000000000000' }),
    series(20, 'Archivée', { followed: true, archived: true }),
    series(30, 'Plus tard', { followed: false, forLater: true }),
    series(40, 'Plus suivie', { followed: false }),
  ].join('\n');
  const d = parseTvTime(csv);
  assert.deepEqual(d.watches.map((w) => [w.season, w.number, w.watchedAt]), [[1, 1, '2024-01-15T21:30:00.000Z'], [1, 2, '2024-02-02T20:00:00.000Z']]);
  assert.equal(d.watches[0]?.showName, 'Love, Death & Robots');
  assert.deepEqual(d.series.map((s) => [s.tvdbShowId, s.followed, s.shelved]), [[10, true, false], [20, true, true], [30, false, true], [40, false, false]]);
  assert.equal(d.series[0]?.addedAt, new Date(1706000000000).toISOString());
  assert.equal(d.series[1]?.addedAt, '2024-01-01T10:00:00.000Z');
});

test('parseTvTime : un autre fichier est refusé clairement', () => {
  assert.throws(() => parseTvTime('a,b\n1,2\n'), TvTimeFormatError);
});

// TMDB simulé : /find par id TheTVDB de série (tv_results) ou d'épisode (tv_episode_results).
function fakeTmdb(shows: Record<number, number>, episodes: Record<number, [number, number, number]> = {}): Tmdb & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    calls: () => paths.length,
    async get<T>(path: string): Promise<T> {
      paths.push(path);
      const id = Number(path.split('/').pop());
      const ep = episodes[id];
      return { tv_results: shows[id] ? [{ id: shows[id] }] : [], tv_episode_results: ep ? [{ show_id: ep[0], season_number: ep[1], episode_number: ep[2] }] : [] } as T;
    },
  };
}

function setup() {
  const db = testDb();
  const catalog = new FakeCatalog(db, [
    { id: 1001, name: 'Série A', seasons: [['2020-01-01', '2020-01-08', '2020-01-15'], ['2021-01-01', '2021-01-08']] },
    { id: 1002, name: 'Série B', seasons: [['2022-01-01', '2022-01-08']] },
  ]);
  const userId = addUser(db, 'camille');
  return { db, catalog, userId };
}

const CSV = [HEADER,
  watch('watch', 10, 501, 1, 1, '2024-01-10 20:00:00', 'Série A'),
  watch('watch', 10, 502, 1, 2, '2024-01-11 20:00:00', 'Série A'),
  watch('watch', 10, 777, 3, 1, '2024-01-12 20:00:00', 'Série A'),          // numérotation TheTVDB : S3E1 = S2E1 chez TMDB
  watch('watch', 10, 888, 9, 9, '2024-01-13 20:00:00', 'Série A'),          // introuvable
  watch('watch', 20, 601, 1, 1, '2024-01-14 20:00:00', 'Série B'),
  watch('watch', 99, 901, 1, 1, '2024-01-15 20:00:00', 'Inconnue'),
  series(10, 'Série A', { followed: true }),
  series(20, 'Série B', { followed: true, archived: true }),
  series(99, 'Inconnue', { followed: true }),
].join('\n');

test('import : séries par id TheTVDB, épisodes par position puis par id d\'épisode, suivi et De côté, bilan', async () => {
  const { db, catalog, userId } = setup();
  const tmdb = fakeTmdb({ 10: 1001, 20: 1002 }, { 777: [1001, 2, 1] });
  const r = await importTvTime({ db, catalog, tmdb }, userId, parseTvTime(CSV));
  assert.deepEqual(r.shows, { found: 2, missing: [{ tvdbId: 99, name: 'Inconnue' }] });
  assert.equal(r.episodes.imported, 4);
  assert.deepEqual(r.episodes.missing, [{ show: 'Série A', season: 9, number: 9 }, { show: 'Inconnue', season: 1, number: 1 }]);
  assert.deepEqual(r.relations, { followed: 1, shelved: 1, kept: 0 });
  const rows = db.prepare('SELECT episode_id AS id, watched_at AS at FROM watched WHERE user_id = ? ORDER BY at').all(userId);
  assert.deepEqual(rows.map((x: any) => [x.id, x.at]), [
    [epId(1001, 1, 1), '2024-01-10T20:00:00.000Z'], [epId(1001, 1, 2), '2024-01-11T20:00:00.000Z'],
    [epId(1001, 2, 1), '2024-01-12T20:00:00.000Z'], [epId(1002, 1, 1), '2024-01-14T20:00:00.000Z'],
  ]);
  assert.deepEqual(db.prepare('SELECT show_id AS id, state FROM user_shows WHERE user_id = ? ORDER BY show_id').all(userId).map((x: any) => [x.id, x.state]),
    [[1001, 'followed'], [1002, 'shelved']]);
});

test('import : relancé, ne change rien (dates et états existants gardés) ; essai à blanc sans écriture', async () => {
  const { db, catalog, userId } = setup();
  await catalog.ensureShow(1001);
  db.prepare('UPDATE shows SET tvdb_id = 10 WHERE id = 1001').run();
  const tmdb = fakeTmdb({ 20: 1002 }, { 777: [1001, 2, 1] });

  const dry = await importTvTime({ db, catalog, tmdb }, userId, parseTvTime(CSV), { dryRun: true });
  assert.equal(dry.episodes.imported, 4);
  assert.equal((db.prepare('SELECT count(*) n FROM watched').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM user_shows').get() as { n: number }).n, 0);
  assert.ok(!tmdb.paths.includes('/find/10'), 'série déjà en cache avec son id TheTVDB : pas d\'appel /find');

  // Un épisode déjà vu à une autre date et une série déjà mise de côté : conservés.
  db.prepare("INSERT INTO watched (user_id, episode_id, watched_at) VALUES (?, ?, '2025-05-05T05:05:05.000Z')").run(userId, epId(1001, 1, 1));
  db.prepare("INSERT INTO user_shows (user_id, show_id, state, added_at) VALUES (?, 1001, 'shelved', '2025-01-01T00:00:00.000Z')").run(userId);
  const first = await importTvTime({ db, catalog, tmdb }, userId, parseTvTime(CSV));
  assert.deepEqual([first.episodes.imported, first.episodes.alreadySeen], [3, 1]);
  assert.deepEqual(first.relations, { followed: 0, shelved: 1, kept: 1 });
  assert.equal((db.prepare('SELECT watched_at AS at FROM watched WHERE episode_id = ?').get(epId(1001, 1, 1)) as { at: string }).at, '2025-05-05T05:05:05.000Z');
  assert.equal((db.prepare('SELECT state FROM user_shows WHERE show_id = 1001').get() as { state: string }).state, 'shelved');

  const again = await importTvTime({ db, catalog, tmdb }, userId, parseTvTime(CSV));
  assert.deepEqual([again.episodes.imported, again.episodes.alreadySeen], [0, 4]);
  assert.deepEqual(again.relations, { followed: 0, shelved: 0, kept: 2 });
});
