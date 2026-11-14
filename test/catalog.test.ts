import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createTmdb } from '../src/infra/tmdb.ts';
import { createCatalog, pickProviders } from '../src/infra/catalog.ts';
import { fakeFetch, loadFixtures } from './helpers/fake-tmdb.ts';

const TLOU = 100088;
const TULSA = 153312;
const TLOU_SHOW = '/tv/100088?append_to_response=external_ids&language=fr-FR';
const TLOU_SEASONS = '/tv/100088?append_to_response=season/1,season/2&language=fr-FR';
const TULSA_SHOW = '/tv/153312?append_to_response=external_ids&language=fr-FR';
const TULSA_SEASONS = '/tv/153312?append_to_response=season/1,season/2,season/3,season/4&language=fr-FR';
const TULSA_VO = '/tv/153312?append_to_response=season/4&language=en';
const HOUR = 3600 * 1000;

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const routes = loadFixtures();
  const { fetch, requests } = fakeFetch(routes);
  let clock = new Date('2026-11-14T10:00:00.000Z');
  const tmdb = createTmdb({ token: 'jeton-test', fetch, sleep: async () => {} });
  const warnings: string[] = [];
  const catalog = createCatalog({ db, tmdb, now: () => clock, warn: (m) => void warnings.push(m) });
  // Fixture modifiable par le test (le faux fetch relit la Map à chaque requête).
  const body = (key: string): any => routes.get(key);
  const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));
  // Lignes node:sqlite (prototype nul) copiées en objets ordinaires pour deepEqual.
  const all = (sql: string, ...p: (number | string)[]) => db.prepare(sql).all(...p).map((r) => ({ ...r })) as any[];
  const one = (sql: string, ...p: (number | string)[]): any => {
    const r = db.prepare(sql).get(...p);
    return r && { ...r };
  };
  return { db, routes, requests, tmdb, catalog, body, advance, all, one, warnings };
}

function watch(db: ReturnType<typeof openDb>, episodeId: number): void {
  db.prepare("INSERT OR IGNORE INTO users (id, username, pw_hash, created_at) VALUES (1, 'ben', '!', '2026-11-14T00:00:00.000Z')").run();
  db.prepare("INSERT INTO watched (user_id, episode_id, watched_at) VALUES (1, ?, '2026-11-14T00:00:00.000Z')").run(episodeId);
}

test('ensureShow : champs de la série, des saisons et des épisodes', async () => {
  const t = setup();
  await t.catalog.ensureShow(TLOU);
  assert.deepEqual(t.requests.map((r) => r.key), [TLOU_SHOW, TLOU_SEASONS]);

  const show = t.one('SELECT * FROM shows WHERE id = ?', TLOU);
  assert.equal(show.name, 'The Last of Us');
  assert.equal(show.original_name, 'The Last of Us');
  assert.equal(show.original_language, 'en');
  assert.equal(show.status, 'returning');
  assert.equal(show.first_air_date, '2023-01-15');
  assert.equal(show.poster_path, '/4pMd9VAdqm96KA2W4X8yetgc7EF.jpg');
  assert.equal(show.tvdb_id, 392256);
  assert.equal(show.refreshed_at, '2026-11-14T10:00:00.000Z');
  assert.match(show.overview, /^Vingt ans après/);

  assert.deepEqual(t.all('SELECT number, name FROM seasons WHERE show_id = ? ORDER BY number', TLOU), [
    { number: 1, name: 'Saison 1' },
    { number: 2, name: 'Saison 2' },
  ]);
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE show_id = ?', TLOU).n, 16);
  const e = t.one('SELECT * FROM episodes WHERE show_id = ? AND season = 1 AND number = 1', TLOU);
  assert.equal(e.id, 2181581);
  assert.equal(e.title, 'Quand tu es perdu dans les ténèbres');
  assert.equal(e.title_is_vo, 0);
  assert.equal(e.air_date, '2023-01-15');
  assert.equal(e.runtime, 81);
  assert.equal(e.still_path, '/3VeY1k8wFyhcrMyQ8jpGegh9beU.jpg');
  assert.match(e.overview, /^Alors qu'une pandémie/);
});

test('saison 0 (spéciaux) ignorée, statut TMDB inconnu → unknown', async () => {
  const t = setup();
  t.body(TLOU_SHOW).seasons.unshift({ season_number: 0, name: 'Épisodes spéciaux' });
  t.body(TLOU_SHOW).status = 'Statut exotique';
  await t.catalog.ensureShow(TLOU);
  assert.deepEqual(t.requests.map((r) => r.key), [TLOU_SHOW, TLOU_SEASONS]);
  assert.equal(t.one('SELECT status FROM shows').status, 'unknown');
  assert.equal(t.one('SELECT count(*) n FROM seasons WHERE number = 0').n, 0);
});

test('titres génériques : repli sur la langue originale pour les seules saisons concernées', async () => {
  const t = setup();
  await t.catalog.ensureShow(TULSA);
  assert.deepEqual(t.requests.map((r) => r.key), [TULSA_SHOW, TULSA_SEASONS, TULSA_VO]);

  const ep = (n: number) => t.one('SELECT title, title_is_vo, overview FROM episodes WHERE show_id = ? AND season = 4 AND number = ?', TULSA, n);
  assert.deepEqual({ ...ep(1), overview: undefined }, { title: 'Q.Q.D.F', title_is_vo: 0, overview: undefined });
  assert.equal(ep(6).title, 'Racket Club');
  assert.equal(ep(6).title_is_vo, 1);
  assert.match(ep(6).overview, /^Dwight battles Turco/); // résumé FR vide → VO
  assert.equal(ep(8).overview, ''); // vide dans les deux langues
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE title_is_vo = 1').n, 5);
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE show_id = ? AND season < 4 AND title_is_vo = 1', TULSA).n, 0);
});

test('titre original lui aussi générique ou vide → titre NULL', async () => {
  const t = setup();
  const vo = t.body(TULSA_VO)['season/4'].episodes;
  vo[8].name = 'Episode 9';
  vo[9].name = '';
  await t.catalog.ensureShow(TULSA);
  const rows = t.all('SELECT number, title, title_is_vo FROM episodes WHERE show_id = ? AND season = 4 AND number >= 8 ORDER BY number', TULSA);
  assert.deepEqual(rows, [
    { number: 8, title: 'Storm Front', title_is_vo: 1 },
    { number: 9, title: null, title_is_vo: 0 },
    { number: 10, title: null, title_is_vo: 0 },
  ]);
});

test('série en français : pas de rechargement, titre générique → NULL', async () => {
  const t = setup();
  t.body(TULSA_SHOW).original_language = 'fr';
  t.body(TULSA_SEASONS).original_language = 'fr';
  await t.catalog.ensureShow(TULSA);
  assert.ok(!t.requests.some((r) => r.key.includes('language=en')));
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE title IS NULL').n, 5);
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE title_is_vo = 1').n, 0);
});

test('cache : aucun appel pendant 24 h, rafraîchi ensuite ; appels simultanés partagés', async () => {
  const t = setup();
  await Promise.all([t.catalog.ensureShow(TLOU), t.catalog.ensureShow(TLOU)]);
  assert.equal(t.tmdb.calls(), 2);

  t.advance(23 * HOUR);
  await t.catalog.ensureShow(TLOU);
  assert.equal(t.tmdb.calls(), 2);

  t.advance(2 * HOUR);
  t.body(TLOU_SEASONS)['season/1'].episodes[0].name = 'Nouveau titre';
  await t.catalog.ensureShow(TLOU);
  assert.equal(t.tmdb.calls(), 4);
  assert.equal(t.one('SELECT title FROM episodes WHERE id = 2181581').title, 'Nouveau titre');
  assert.equal(t.one('SELECT refreshed_at FROM shows').refreshed_at, '2026-11-15T11:00:00.000Z');
});

test('épisode disparu chez TMDB : conservé comme retiré s\'il a été vu, supprimé sinon', async () => {
  const t = setup();
  await t.catalog.ensureShow(TLOU);
  const s2 = t.body(TLOU_SEASONS)['season/2'].episodes;
  const [e6, e7] = [s2[5].id, s2[6].id];
  watch(t.db, e7);
  s2.splice(5, 2);
  await t.catalog.refreshShow(TLOU);
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE id = ?', e6).n, 0);
  assert.deepEqual(t.one('SELECT season, number, removed_at IS NOT NULL AS removed FROM episodes WHERE id = ?', e7), { season: 2, number: 7, removed: 1 });
  assert.equal(t.one('SELECT count(*) n FROM watched').n, 1);
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE show_id = ?', TLOU).n, 15);
});

test('saison disparue : supprimée si vide, conservée tant qu\'un épisode vu y reste', async () => {
  const t = setup();
  await t.catalog.ensureShow(TLOU);
  const s1Only = '/tv/100088?append_to_response=season/1&language=fr-FR';
  const full = t.body(TLOU_SEASONS);
  const watchedId = full['season/2'].episodes[2].id;
  t.body(TLOU_SHOW).seasons.pop();
  t.routes.set(s1Only, { ...full, 'season/2': undefined });

  watch(t.db, watchedId);
  await t.catalog.refreshShow(TLOU);
  assert.deepEqual(t.all('SELECT number FROM seasons ORDER BY number').map((r) => r.number), [1, 2]);
  assert.deepEqual(t.all('SELECT id FROM episodes WHERE season = 2').map((r) => r.id), [watchedId]);

  t.db.prepare('DELETE FROM watched').run();
  await t.catalog.refreshShow(TLOU);
  assert.deepEqual(t.all('SELECT number FROM seasons ORDER BY number').map((r) => r.number), [1]);
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE season = 2').n, 0);
});

test('id d\'épisode changé chez TMDB : le visionnage suit le nouvel id', async () => {
  const t = setup();
  await t.catalog.ensureShow(TLOU);
  watch(t.db, 2181581);
  t.body(TLOU_SEASONS)['season/1'].episodes[0].id = 999000001;
  await t.catalog.refreshShow(TLOU);
  assert.equal(t.one('SELECT count(*) n FROM episodes WHERE id = 2181581').n, 0);
  assert.deepEqual(t.one('SELECT season, number FROM episodes WHERE id = 999000001'), { season: 1, number: 1 });
  assert.deepEqual(t.all('SELECT episode_id FROM watched'), [{ episode_id: 999000001 }]);
  assert.equal(t.one('SELECT count(*) n FROM episodes').n, 16);
});

test('renumérotation (deux épisodes échangés) sans conflit d\'unicité', async () => {
  const t = setup();
  await t.catalog.ensureShow(TLOU);
  const eps = t.body(TLOU_SEASONS)['season/1'].episodes;
  [eps[0].episode_number, eps[1].episode_number] = [2, 1];
  watch(t.db, eps[0].id);
  await t.catalog.refreshShow(TLOU);
  assert.equal(t.one('SELECT number FROM episodes WHERE id = ?', eps[0].id).number, 2);
  assert.equal(t.one('SELECT number FROM episodes WHERE id = ?', eps[1].id).number, 1);
  assert.deepEqual(t.all('SELECT episode_id FROM watched'), [{ episode_id: eps[0].id }]);
});

test('plateformes : abonnement seulement, variantes exclues, cache 24 h', async () => {
  const t = setup();
  await t.catalog.ensureProviders(TULSA, 'fr');
  const rows = t.all('SELECT season, country, provider_id, name, priority FROM providers WHERE season = 1 ORDER BY priority');
  assert.deepEqual(rows, [
    { season: 1, country: 'FR', provider_id: 531, name: 'Paramount Plus', priority: 53 },
    { season: 1, country: 'FR', provider_id: 2303, name: 'Paramount Plus Premium', priority: 78 },
  ]);
  assert.equal(t.one("SELECT count(*) n FROM providers WHERE name LIKE '%channel%'").n, 0);
  assert.equal(t.one('SELECT count(*) n FROM provider_fetches WHERE show_id = ?', TULSA).n, 5, '4 saisons + la série (saison 0)');

  const before = t.tmdb.calls();
  await t.catalog.ensureProviders(TULSA, 'FR');
  assert.equal(t.tmdb.calls(), before);
});

test('plateformes : liste vide enregistrée, remplacement complet après 24 h', async () => {
  const t = setup();
  await t.catalog.ensureProviders(TLOU, 'DE');
  assert.equal(t.one("SELECT count(*) n FROM provider_fetches WHERE country = 'DE'").n, 3);
  assert.equal(t.one('SELECT count(*) n FROM providers').n, 0);

  await t.catalog.ensureProviders(TLOU, 'FR');
  assert.deepEqual(t.all("SELECT season, name FROM providers WHERE country = 'FR' ORDER BY season"), [
    { season: 1, name: 'HBO Max' },
    { season: 2, name: 'HBO Max' },
  ]);

  t.body('/tv/100088/season/1/watch/providers').results.FR.flatrate = [];
  t.routes.delete('/tv/100088/season/2/watch/providers'); // 404 → liste vide
  t.advance(25 * HOUR);
  const before = t.tmdb.calls();
  await t.catalog.ensureProviders(TLOU, 'FR');
  assert.equal(t.tmdb.calls() - before, 5); // série (2) + plateformes (série + 2 saisons)
  assert.equal(t.one("SELECT count(*) n FROM providers WHERE country = 'FR'").n, 0);
  assert.equal(t.one("SELECT fetched_at FROM provider_fetches WHERE country = 'FR' AND season = 1").fetched_at, '2026-11-15T11:00:00.000Z');
});

test('pickProviders : une ligne par plateforme, meilleure priorité', () => {
  const res = {
    results: {
      FR: {
        flatrate: [
          { provider_id: 1, provider_name: 'A', display_priority: 5 },
          { provider_id: 1, provider_name: 'A', display_priority: 2 },
          { provider_id: 2, provider_name: 'B with Ads', display_priority: 1 },
          { provider_id: 3, provider_name: 'C APPLE TV CHANNEL', display_priority: 1 },
        ],
      },
    },
  };
  assert.deepEqual(pickProviders(res, 'FR'), [{ provider_id: 1, name: 'A', logo_path: null, priority: 2 }]);
  assert.deepEqual(pickProviders(res, 'US'), []);
});

test('recherche : requête nettoyée, résultats convertis, vide → aucun appel', async () => {
  const t = setup();
  assert.deepEqual(await t.catalog.searchShows('   '), []);
  assert.equal(t.tmdb.calls(), 0);

  const results = await t.catalog.searchShows('  the   last of us ');
  assert.equal(t.tmdb.calls(), 1);
  assert.deepEqual(results[0], { id: 100088, name: 'The Last of Us', originalName: 'The Last of Us', year: 2023, posterPath: '/4pMd9VAdqm96KA2W4X8yetgc7EF.jpg' });
  assert.equal(results[1]!.posterPath, null);
  assert.equal(results.length, 3);

  const key = '/search/tv?include_adult=false&language=fr-FR&query=the+last+of+us';
  t.body(key).results[0].first_air_date = '';
  assert.equal((await t.catalog.searchShows('the last of us'))[0]!.year, null);
});

// TMDB retire un épisode et décale la suite : E(n+1) prend le numéro n.
function dropAndRenumber(eps: { episode_number: number }[], index: number): void {
  eps.splice(index, 1);
  for (const e of eps.slice(index)) e.episode_number--;
}

test('épisode vu retiré puis suite renumérotée : le visionnage ne passe pas sur l\'épisode suivant', async () => {
  for (const index of [0, 2]) {
    const t = setup();
    await t.catalog.ensureShow(TLOU);
    const eps = t.body(TLOU_SEASONS)['season/1'].episodes;
    const [seen, next] = [eps[index].id, eps[index + 1].id];
    watch(t.db, seen);
    dropAndRenumber(eps, index);
    await t.catalog.refreshShow(TLOU);
    assert.deepEqual(t.one('SELECT season, number, removed_at IS NOT NULL AS removed FROM episodes WHERE id = ?', seen), { season: 1, number: index + 1, removed: 1 });
    assert.deepEqual(t.one('SELECT number, removed_at FROM episodes WHERE id = ?', next), { number: index + 1, removed_at: null });
    assert.deepEqual(t.all('SELECT episode_id FROM watched'), [{ episode_id: seen }]);
    assert.equal(t.one('SELECT count(*) n FROM episodes WHERE removed_at IS NULL').n, 15);
  }
});

test('épisode vu retiré : un nouvel épisode arrivé plus tard à sa place ne reprend pas le visionnage', async () => {
  const t = setup();
  await t.catalog.ensureShow(TLOU);
  const eps = t.body(TLOU_SEASONS)['season/2'].episodes;
  const last = eps.pop();
  watch(t.db, last.id);
  await t.catalog.refreshShow(TLOU);
  eps.push({ ...last, id: 999000002 });
  await t.catalog.refreshShow(TLOU);
  assert.deepEqual(t.one('SELECT number, removed_at IS NOT NULL AS removed FROM episodes WHERE id = ?', last.id), { number: last.episode_number, removed: 1 });
  assert.deepEqual(t.one('SELECT number, removed_at FROM episodes WHERE id = 999000002'), { number: last.episode_number, removed_at: null });
  assert.deepEqual(t.all('SELECT episode_id FROM watched'), [{ episode_id: last.id }]);
});

test('TMDB en panne : série en cache servie périmée, pas de nouvel appel pendant 15 min', async () => {
  const t = setup();
  await t.catalog.ensureProviders(TLOU, 'FR');
  const providers = t.all('SELECT season, name FROM providers ORDER BY season');
  t.advance(25 * HOUR);
  for (const key of [TLOU_SHOW, '/tv/100088/watch/providers', '/tv/100088/season/1/watch/providers', '/tv/100088/season/2/watch/providers']) {
    t.routes.set(key, () => ({ status: 503 }));
  }

  const before = t.tmdb.calls();
  await t.catalog.ensureProviders(TLOU, 'FR');
  assert.equal(t.tmdb.calls() - before, 16); // série, plateformes de la série + 2 saisons, 4 essais chacun
  assert.equal(t.one('SELECT refreshed_at FROM shows').refreshed_at, '2026-11-14T10:00:00.000Z');
  assert.deepEqual(t.all('SELECT season, name FROM providers ORDER BY season'), providers);
  assert.equal(t.warnings.length, 4);
  assert.ok(t.warnings.every((w) => !w.includes('jeton-test')));

  await t.catalog.ensureShow(TLOU);
  await t.catalog.ensureProviders(TLOU, 'FR');
  assert.equal(t.tmdb.calls() - before, 16);

  t.advance(16 * 60 * 1000);
  t.routes.set(TLOU_SHOW, loadFixtures().get(TLOU_SHOW));
  await t.catalog.ensureShow(TLOU);
  assert.equal(t.one('SELECT refreshed_at FROM shows').refreshed_at, '2026-11-15T11:16:00.000Z');
});

test('TMDB en panne : série absente du cache → erreur', async () => {
  const t = setup();
  t.routes.set(TLOU_SHOW, () => ({ status: 503 }));
  await assert.rejects(t.catalog.ensureShow(TLOU), (err: Error) => err.name === 'TmdbError');
  assert.equal(t.one('SELECT count(*) n FROM shows').n, 0);
  assert.equal(t.warnings.length, 0);
});
