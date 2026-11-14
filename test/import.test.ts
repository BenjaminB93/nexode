import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseImportFiles } from '../src/domain/import-files.ts';
import { normTitle, parseCsv, splitYear, wallTimeToUtc } from '../src/domain/imports.ts';
import { parseTvTime } from '../src/domain/tvtime.ts';
import { parseBetaSeriesEpisodes, parseBetaSeriesSeries } from '../src/domain/betaseries.ts';
import { applyImport, importHistory, matchShows } from '../src/usecases/import.ts';
import { FakeCatalog, epId, testDb } from './helpers/fake-catalog.ts';
import { addUser } from './helpers/auth.ts';

const TV_HEADER = 'runtime,ep_no,ep_id,key,s_id,user_id,s_no,created_at,gsi,updated_at,total_series_runtime,ep_watch_count,movie_watch_count,total_movies_runtime,series_follow_count,is_followed,followed_at,is_archived,most_recent_ep_watched,uuid,is_for_later,bulk_type,is_unitary,rewatch_count,is_special,movie_name,series_name,season_number,episode_number';
const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function tvWatch(kind: 'watch' | 'rewatch', sId: number, epTvdb: number, s: number, e: number, at: string, name: string, special = ''): string {
  const c = Array<string>(29).fill('');
  c[1] = String(e); c[2] = String(epTvdb); c[3] = `${kind}-episode-x-${sId}-${s}-${e}-${at}`; c[4] = String(sId); c[6] = String(s); c[7] = at;
  c[24] = special; c[26] = q(name); c[27] = String(s); c[28] = String(e);
  return c.join(',');
}
function tvSeries(sId: number, name: string, o: { followed: boolean; archived?: boolean; forLater?: boolean; followedAt?: string }): string {
  const c = Array<string>(29).fill('');
  c[3] = `user-series-${sId}`; c[4] = String(sId); c[7] = '2024-01-01 10:00:00'; c[15] = String(o.followed); c[16] = o.followedAt ?? '';
  c[17] = String(!!o.archived); c[18] = '"map[ep_id:1 ep_no:1]"'; c[20] = String(!!o.forLater); c[26] = q(name);
  return c.join(',');
}
const bsEpisodes = (rows: [string, string, string][]) =>
  ['id,show,episode,title,date,note', ...rows.map(([show, code, date], i) => [i + 1, q(show), code, 'Titre', q(date), ''].join(','))].join('\n');
const bsSeries = (rows: [string, number][]) =>
  ['id,title,archive,episode,remaining,status,tags,note', ...rows.map(([title, archive], i) => [i + 1, q(title), archive, 'S00E00', 0, 100, '', ''].join(','))].join('\n');

// ---------- lecture ----------

test('parseCsv : guillemets, guillemets doublés, virgules et retours à la ligne dans un champ, CRLF', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e"""\r\n"f\ng",h\n'), [['a', 'b, c', 'd "e"'], ['f\ng', 'h']]);
});

test('outils : titre normalisé, année entre parenthèses, heure de Paris → UTC (hiver et été)', () => {
  assert.equal(normTitle('Star Trek : Strange New Worlds'), normTitle('Star Trek: Strange New Worlds'));
  assert.equal(normTitle('Astérix & Obélix'), 'asterixandobelix');
  assert.deepEqual(splitYear('Once Upon a Time (2011)'), { title: 'Once Upon a Time', year: 2011 });
  assert.deepEqual(splitYear('Doctor Who'), { title: 'Doctor Who', year: null });
  assert.equal(wallTimeToUtc('2016-01-16 19:17:10', 'Europe/Paris'), '2016-01-16T18:17:10.000Z');
  assert.equal(wallTimeToUtc('2016-09-16 19:17:10', 'Europe/Paris'), '2016-09-16T17:17:10.000Z');
});

test('détection du format par l\'en-tête ; un autre fichier est signalé sans bloquer les autres', () => {
  assert.equal(detectFormat(TV_HEADER + '\n'), 'tvtime');
  assert.equal(detectFormat(bsEpisodes([])), 'betaseries-episodes');
  assert.equal(detectFormat(bsSeries([])), 'betaseries-series');
  const r = parseImportFiles([{ name: 'a.csv', text: 'x,y\n1,2' }, { name: 'b.csv', text: bsSeries([['Lost', 0]]) }]);
  assert.deepEqual(r.files.map((f) => [f.name, f.format, !!f.error]), [['a.csv', null, true], ['b.csv', 'betaseries-series', false]]);
  assert.equal(r.data.series.length, 1);
});

test('TV Time : premier visionnage gardé, spéciaux ignorés, états de suivi, dates UTC', () => {
  const d = parseTvTime([TV_HEADER,
    tvWatch('watch', 10, 501, 1, 1, '2024-02-01 20:00:00', 'Love, Death & Robots'),
    tvWatch('rewatch', 10, 501, 1, 1, '2024-01-15 21:30:00', 'Love, Death & Robots'),
    tvWatch('watch', 10, 502, 1, 2, '2024-02-02 20:00:00', 'Love, Death & Robots'),
    tvWatch('watch', 10, 590, 0, 1, '2024-02-03 20:00:00', 'Love, Death & Robots'),
    tvWatch('watch', 10, 591, 2, 1, '2024-02-04 20:00:00', 'Love, Death & Robots', 'true'),
    tvSeries(10, 'Love, Death & Robots', { followed: true, followedAt: '1706000000000000' }),
    tvSeries(20, 'Archivée', { followed: true, archived: true }),
    tvSeries(30, 'Plus tard', { followed: false, forLater: true }),
    tvSeries(40, 'Plus suivie', { followed: false }),
  ].join('\n'));
  assert.deepEqual(d.watches.map((w) => [w.show.tvdbId, w.show.title, w.season, w.number, w.watchedAt]), [
    [10, 'Love, Death & Robots', 1, 1, '2024-01-15T21:30:00.000Z'], [10, 'Love, Death & Robots', 1, 2, '2024-02-02T20:00:00.000Z']]);
  assert.deepEqual(d.series.map((s) => [s.show.tvdbId, s.followed, s.shelved]), [[10, true, false], [20, true, true], [30, false, true], [40, false, false]]);
  assert.equal(d.series[0]?.addedAt, new Date(1706000000000).toISOString());
  assert.equal(d.series[1]?.addedAt, '2024-01-01T10:00:00.000Z');
});

test('BetaSeries : titre et année, code SxxEyy, spéciaux ignorés, archive → de côté', () => {
  const e = parseBetaSeriesEpisodes(bsEpisodes([
    ['Once Upon a Time (2011)', 'S02E16', '2016-09-16 19:17:10'],
    ['Once Upon a Time (2011)', 'S02E16', '2016-09-15 10:00:00'],
    ['Once Upon a Time (2011)', 'S00E01', '2016-09-16 19:17:10'],
    ['Doctor Who', 'S26E14', '2021-03-01 21:00:00'],
  ]));
  assert.deepEqual(e.watches.map((w) => [w.show.title, w.show.year, w.season, w.number, w.watchedAt]), [
    ['Once Upon a Time', 2011, 2, 16, '2016-09-15T08:00:00.000Z'], ['Doctor Who', null, 26, 14, '2021-03-01T20:00:00.000Z']]);
  const s = parseBetaSeriesSeries(bsSeries([['Lost', 0], ['Avenue 5', 1]]));
  assert.deepEqual(s.series.map((x) => [x.show.title, x.followed, x.shelved]), [['Lost', true, false], ['Avenue 5', true, true]]);
});

// ---------- import ----------

function setup() {
  const db = testDb();
  const catalog = new FakeCatalog(db, [
    { id: 1001, name: 'Série A', seasons: [['2020-01-01', '2020-01-08', '2020-01-15'], ['2021-01-01', '2021-01-08']] },
    { id: 1002, name: 'Série B', seasons: [['2022-01-01', '2022-01-08']] },
    { id: 2001, name: 'Doctor Who', firstAirDate: '2005-03-26', seasons: [['2005-03-26', '2005-04-02']] },
    { id: 2002, name: 'Doctor Who', firstAirDate: '1963-11-23', seasons: [['1963-11-23'], ['1964-10-31', '1964-11-07', '1964-11-14']] },
    { id: 3001, name: 'She-Hulk : Avocate', seasons: [['2022-08-18']] },
  ]);
  catalog.tvdbShows.set(10, 1001).set(20, 1002);
  catalog.tvdbEpisodes.set(777, { showId: 1001, season: 2, number: 1 });
  return { db, catalog, userId: addUser(db, 'camille') };
}

const TVTIME = [TV_HEADER,
  tvWatch('watch', 10, 501, 1, 1, '2024-01-10 20:00:00', 'Série A'),
  tvWatch('watch', 10, 502, 1, 2, '2024-01-11 20:00:00', 'Série A'),
  tvWatch('watch', 10, 777, 3, 1, '2024-01-12 20:00:00', 'Série A'),     // numérotation TheTVDB : S3E1 = S2E1 chez TMDB
  tvWatch('watch', 10, 888, 9, 9, '2024-01-13 20:00:00', 'Série A'),     // introuvable
  tvWatch('watch', 20, 601, 1, 1, '2024-01-14 20:00:00', 'Série B'),
  tvWatch('watch', 99, 901, 1, 1, '2024-01-15 20:00:00', 'Inconnue'),
  tvSeries(10, 'Série A', { followed: true }),
  tvSeries(20, 'Série B', { followed: true, archived: true }),
  tvSeries(99, 'Inconnue', { followed: true }),
].join('\n');

const watchedRows = (db: ReturnType<typeof testDb>, userId: number) =>
  (db.prepare('SELECT episode_id AS id, watched_at AS at FROM watched WHERE user_id = ? ORDER BY episode_id').all(userId) as { id: number; at: string }[]).map((x) => [x.id, x.at]);

test('import TV Time : séries par id TheTVDB, épisodes par position puis par id d\'épisode, suivi et De côté', async () => {
  const { db, catalog, userId } = setup();
  const { matches, report: r } = await importHistory({ db, catalog }, userId, parseTvTime(TVTIME));
  assert.deepEqual(matches.map((m) => [m.title, m.kind, m.choice]), [['Série A', 'sure', 1001], ['Série B', 'sure', 1002], ['Inconnue', 'missing', null]]);
  assert.deepEqual(r.shows, { imported: 2, skipped: ['Inconnue'] });
  assert.equal(r.episodes.imported, 4);
  assert.deepEqual(r.episodes.missing, [{ show: 'Série A', season: 9, number: 9 }], 'une série non importée ne compte pas ses épisodes comme manquants');
  assert.deepEqual(r.relations, { followed: 1, shelved: 1, kept: 0 });
  assert.deepEqual(watchedRows(db, userId), [
    [epId(1001, 1, 1), '2024-01-10T20:00:00.000Z'], [epId(1001, 1, 2), '2024-01-11T20:00:00.000Z'],
    [epId(1001, 2, 1), '2024-01-12T20:00:00.000Z'], [epId(1002, 1, 1), '2024-01-14T20:00:00.000Z'],
  ]);
  assert.deepEqual(db.prepare('SELECT show_id AS id, state FROM user_shows WHERE user_id = ? ORDER BY show_id').all(userId).map((x: any) => [x.id, x.state]),
    [[1001, 'followed'], [1002, 'shelved']]);
});

test('import BetaSeries : homonymes départagés par les épisodes vus, titre rapproché signalé, année respectée', async () => {
  const { db, catalog, userId } = setup();
  await catalog.ensureShow(2001);   // la série de 2005 est déjà en cache : l'homonyme de 1963 doit quand même être trouvé
  const { data } = parseImportFiles([
    { name: 'episodes.csv', text: bsEpisodes([
      ['Doctor Who', 'S02E03', '2021-03-01 21:00:00'],
      ['Doctor Who', 'S02E02', '2021-03-01 21:00:00'],
      ['Doctor Who (2005)', 'S01E01', '2021-04-01 21:00:00'],
      ["Marvel's She-Hulk", 'S01E01', '2022-09-01 21:00:00'],
    ]) },
    { name: 'series.csv', text: bsSeries([['Doctor Who', 0], ['Doctor Who (2005)', 1], ["Marvel's She-Hulk", 0]]) },
  ]);
  catalog.searchShows = async (query: string, year?: number) => {
    const all = [
      { id: 2001, name: 'Doctor Who', originalName: 'Doctor Who', year: 2005, posterPath: null },
      { id: 2002, name: 'Doctor Who', originalName: 'Doctor Who', year: 1963, posterPath: null },
      { id: 3001, name: 'She-Hulk : Avocate', originalName: 'She-Hulk: Attorney at Law', year: 2022, posterPath: null },
    ];
    const words = normWords(query);
    return all.filter((s) => (!year || s.year === year) && words.some((w) => normWords(s.name).includes(w)));
  };
  const { matches } = await importHistory({ db, catalog }, userId, data);
  const m = new Map(matches.map((x) => [x.title + (x.year ? ` (${x.year})` : ''), x]));
  assert.deepEqual([m.get('Doctor Who')?.kind, m.get('Doctor Who')?.choice], ['sure', 2002], 'homonyme sans aucun épisode vu : pas de question');
  assert.deepEqual([m.get('Doctor Who (2005)')?.kind, m.get('Doctor Who (2005)')?.choice], ['sure', 2001], 'année donnée : un seul titre identique');
  assert.deepEqual([m.get("Marvel's She-Hulk")?.kind, m.get("Marvel's She-Hulk")?.choice], ['approximate', 3001]);
  assert.deepEqual(watchedRows(db, userId).map(([id]) => id), [epId(2001, 1, 1), epId(2002, 2, 2), epId(2002, 2, 3), epId(3001, 1, 1)]);
  assert.deepEqual(db.prepare('SELECT show_id AS id, state FROM user_shows WHERE user_id = ? ORDER BY show_id').all(userId).map((x: any) => [x.id, x.state]),
    [[2001, 'shelved'], [2002, 'followed'], [3001, 'followed']]);
});
const normWords = (s: string) => s.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);

test('import de plusieurs sources : plus ancien visionnage gardé ; de côté seulement si toutes les sources le disent', async () => {
  const { db, catalog, userId } = setup();
  const { data } = parseImportFiles([
    { name: 'tracking-prod-records-v2.csv', text: TVTIME },
    { name: 'episodes.csv', text: bsEpisodes([['Série A', 'S01E01', '2023-06-01 12:00:00'], ['Série A', 'S01E03', '2023-06-02 12:00:00']]) },
    { name: 'series.csv', text: bsSeries([['Série B', 0]]) },
  ]);
  const { report: r } = await importHistory({ db, catalog }, userId, data);
  const rows = new Map(watchedRows(db, userId) as [number, string][]);
  assert.equal(rows.get(epId(1001, 1, 1)), '2023-06-01T10:00:00.000Z', 'BetaSeries plus ancien que TV Time');
  assert.equal(rows.get(epId(1001, 1, 3)), '2023-06-02T10:00:00.000Z');
  assert.equal(r.episodes.imported, 5);
  assert.equal((db.prepare('SELECT state FROM user_shows WHERE show_id = 1002').get() as { state: string }).state, 'followed');
});

test('import relancé : rien ne change (dates et états existants gardés) ; essai à blanc sans écriture', async () => {
  const { db, catalog, userId } = setup();
  const data = parseTvTime(TVTIME);
  const { report: dry } = await importHistory({ db, catalog }, userId, data, { dryRun: true });
  assert.equal(dry.episodes.imported, 4);
  assert.equal((db.prepare('SELECT count(*) n FROM watched').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM user_shows').get() as { n: number }).n, 0);

  db.prepare("INSERT INTO watched (user_id, episode_id, watched_at) VALUES (?, ?, '2025-05-05T05:05:05.000Z')").run(userId, epId(1001, 1, 1));
  db.prepare("INSERT INTO user_shows (user_id, show_id, state, added_at) VALUES (?, 1001, 'shelved', '2025-01-01T00:00:00.000Z')").run(userId);
  const { report: first } = await importHistory({ db, catalog }, userId, data);
  assert.deepEqual([first.episodes.imported, first.episodes.alreadySeen], [3, 1]);
  assert.deepEqual(first.relations, { followed: 0, shelved: 1, kept: 1 });
  assert.equal((db.prepare('SELECT watched_at AS at FROM watched WHERE episode_id = ?').get(epId(1001, 1, 1)) as { at: string }).at, '2025-05-05T05:05:05.000Z');
  assert.equal((db.prepare('SELECT state FROM user_shows WHERE show_id = 1001').get() as { state: string }).state, 'shelved');

  const { report: again } = await importHistory({ db, catalog }, userId, data);
  assert.deepEqual([again.episodes.imported, again.episodes.alreadySeen], [0, 4]);
  assert.deepEqual(again.relations, { followed: 0, shelved: 0, kept: 2 });
});

// ---------- API ----------

test("API d'import : analyse (rien d'écrit), puis import avec les choix ; fichier non reconnu refusé ; corps de plus de 1 Mo", async () => {
  const { createApp } = await import('../src/http/app.ts');
  const { sessionCookie } = await import('./helpers/auth.ts');
  const { db, catalog, userId } = setup();
  const app = createApp({ db, catalog, now: () => new Date('2026-11-14T12:00:00.000Z') });
  const cookie = sessionCookie(db, userId, '2026-11-14T12:00:00.000Z');
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const bad = await post('/api/import/analyze', { files: [{ name: 'notes.csv', text: ['a,b', '1,2'].join('\n') }] });
  assert.deepEqual([bad.status, bad.body.error, bad.body.files[0].format], [400, 'import_format', null]);

  // Remplissage : le fichier dépasse la limite générale de 1 Mo.
  const big = [TVTIME, ...Array.from({ length: 12000 }, () => ','.repeat(28) + 'x')].join('\n');
  const files = [{ name: 'tracking-prod-records-v2.csv', text: big }];
  const analyzed = await post('/api/import/analyze', { files });
  assert.equal(analyzed.status, 200);
  assert.deepEqual(analyzed.body.matches.map((m: any) => [m.key, m.kind, m.choice]), [['tvdb:10', 'sure', 1001], ['tvdb:20', 'sure', 1002], ['tvdb:99', 'missing', null]]);
  assert.equal((db.prepare('SELECT count(*) n FROM watched').get() as { n: number }).n, 0);

  // L'utilisateur écarte la série B.
  const done = await post('/api/import', { files, choices: { 'tvdb:10': 1001, 'tvdb:20': null, 'tvdb:99': null } });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.report.shows.imported, done.body.report.episodes.imported, done.body.report.relations.followed], [1, 3, 1]);
  assert.deepEqual(watchedRows(db, userId).map(([id]) => id), [epId(1001, 1, 1), epId(1001, 1, 2), epId(1001, 2, 1)]);
  assert.equal((await post('/api/import', { files, choices: { 'tvdb:10': 'x' } })).status, 400);
  assert.equal((await post('/api/import/analyze', { files: [] })).status, 400);
});

test("import : une série choisie par l'utilisateur hors des candidats (recherche) est utilisée", async () => {
  const { db, catalog, userId } = setup();
  const { data } = parseImportFiles([{ name: 'episodes.csv', text: bsEpisodes([['Mystère', 'S01E01', '2021-03-01 21:00:00']]) }]);
  const matches = await matchShows({ db, catalog }, userId, data);
  assert.deepEqual(matches.map((m) => [m.kind, m.choice]), [['missing', null]]);
  const r = await applyImport({ db, catalog }, userId, data, new Map([[matches[0]!.key, 1002]]));
  assert.equal(r.episodes.imported, 1);
  assert.deepEqual(watchedRows(db, userId).map(([id]) => id), [epId(1002, 1, 1)]);
});

test('homonymes à égalité d\'épisodes : la série déjà connue l\'emporte (même import ou historique existant)', async () => {
  for (const mode of ['même import', 'import précédent'] as const) {
    const db = testDb();
    const catalog = new FakeCatalog(db, [
      // BetaSeries compte le pilote double 2 fois : E1, E3…E6 ; la série de 2011 n'a que 5 épisodes, celle de 2020 en a 6.
      { id: 5020, name: 'Terra Nova', firstAirDate: '2020-06-03', seasons: [Array(6).fill('2020-06-03')] },
      { id: 5011, name: 'Terra Nova', firstAirDate: '2011-09-26', seasons: [Array(5).fill('2011-09-26')] },
    ]);
    catalog.tvdbShows.set(164091, 5011);
    catalog.searchShows = async () => [
      { id: 5020, name: 'Terra Nova', originalName: 'Terra Nova', year: 2020, posterPath: null },
      { id: 5011, name: 'Terra Nova', originalName: 'Terra Nova', year: 2011, posterPath: null },
    ];
    const userId = addUser(db, 'camille');
    const tv = { name: 'tracking-prod-records-v2.csv', text: [TV_HEADER, tvWatch('watch', 164091, 1, 1, 1, '2022-11-17 19:09:47', 'Terra Nova')].join('\n') };
    const bs = { name: 'episodes.csv', text: bsEpisodes([1, 3, 4, 5, 6].map((e) => ['Terra Nova', 'S01E0' + e, '2022-11-17 20:09:47'] as [string, string, string])) };
    if (mode === 'même import') await importHistory({ db, catalog }, userId, parseImportFiles([bs, tv]).data);
    else {
      await importHistory({ db, catalog }, userId, parseImportFiles([tv]).data);
      await importHistory({ db, catalog }, userId, parseImportFiles([bs]).data);
    }
    assert.deepEqual(watchedRows(db, userId).map(([id]) => id), [1, 3, 4, 5].map((e) => epId(5011, 1, e)), mode);
    const again = (await matchShows({ db, catalog }, userId, parseImportFiles([bs]).data))[0];
    assert.deepEqual([again?.kind, again?.choice, again?.candidates.map((c) => [c.id, c.hits])], ['ambiguous', 5011, [[5011, 4], [5020, 5]]], 'cas serré : à confirmer, la série connue proposée');
  }
});
