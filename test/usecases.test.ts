import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Db } from '../src/db/index.ts';
import { NotAiredError, NotFoundError, UpstreamError } from '../src/usecases/context.ts';
import { history, myShows, shelf, timeline } from '../src/usecases/lists.ts';
import { setRelation } from '../src/usecases/relation.ts';
import { search } from '../src/usecases/search.ts';
import { seasonDetail, showDetail } from '../src/usecases/show.ts';
import { markSeason, markWatched, unmarkWatched, watchedUntil } from '../src/usecases/watched.ts';
import { type ShowFixture, FakeCatalog, epId, makeCtx, testDb } from './helpers/fake-catalog.ts';

const NOW = '2026-11-13T12:00:00.000Z';   // 13 h à Paris

const SEV: ShowFixture = {
  id: 1001, name: 'Severance',
  seasons: [['2026-10-01', '2026-10-08', '2026-10-15'], ['2026-11-13', '2026-11-20', null]],
  providers: { FR: [[350], [350]] },
};
const FINIE: ShowFixture = { id: 1002, name: 'Finie', status: 'ended', seasons: [['2025-01-01', '2025-01-08']] };
const LONGUE: ShowFixture = {
  id: 1003, name: 'Longue',
  seasons: [['2025-12-01', '2025-12-08', '2025-12-15'], ['2026-11-27']],
  providers: { FR: [[8, 119], [119]] },
};

function setup(now = NOW) {
  const db = testDb();
  const catalog = new FakeCatalog(db, [SEV, FINIE, LONGUE]);
  return { db, catalog, ctx: makeCtx(db, catalog, now) };
}
const at = (db: Db, catalog: FakeCatalog, now: string) => makeCtx(db, catalog, now);
const userShow = (db: Db, showId: number) => {
  const row = db.prepare('SELECT state, added_at AS addedAt, resumed_at AS resumedAt FROM user_shows WHERE show_id = ?').get(showId);
  return row && { ...row };
};
const watchedAt = (db: Db, episodeId: number) =>
  (db.prepare('SELECT watched_at AS w FROM watched WHERE episode_id = ?').get(episodeId) as { w: string } | undefined)?.w;

test('suivre depuis « Non suivie » : la série arrive dans En cours', async () => {
  const { db, ctx, catalog } = setup();
  const s = await setRelation(ctx, SEV.id, 'on');
  assert.deepEqual(catalog.calls, ['ensureShow 1001']);
  assert.equal(s.relation, 'on');
  assert.equal(s.status, 'encours');
  assert.equal(s.next?.id, epId(1001, 1, 1));
  assert.equal(s.remaining, 4);                       // S2E1 sort aujourd'hui : compté
  assert.deepEqual(userShow(db, SEV.id), { state: 'followed', addedAt: NOW, resumedAt: null });
  assert.deepEqual(timeline(ctx).toWatch.map((x) => x.show.id), [SEV.id]);
});

test('série mise de côté sans épisode vu → Pas commencées', async () => {
  const { db, ctx } = setup();
  const s = await setRelation(ctx, LONGUE.id, 'shelf');
  assert.equal(s.relation, 'shelf');
  assert.equal(s.status, 'decote');
  assert.equal(s.wouldBeStatus, 'encours');
  assert.equal((userShow(db, LONGUE.id) as { state: string }).state, 'shelved');
  const sh = shelf(ctx);
  assert.deepEqual(sh.notStarted.map((c) => [c.show.id, c.reason.kind]), [[LONGUE.id, 'manual']]);
  assert.deepEqual(sh.abandoned, []);
  assert.deepEqual(timeline(ctx).toWatch, []);
});

test('série à jour mise de côté à la main → decote', async () => {
  const { ctx } = setup();
  await setRelation(ctx, FINIE.id, 'on');
  const done = markSeason(ctx, FINIE.id, 1);
  assert.equal(done.show.status, 'terminee');
  const s = await setRelation(ctx, FINIE.id, 'shelf');
  assert.equal(s.status, 'decote');
  assert.equal(s.wouldBeStatus, 'terminee');
  assert.deepEqual(shelf(ctx).abandoned.map((c) => [c.show.id, c.reason.kind]), [[FINIE.id, 'manual']]);
});

test('seuil : de côté par inactivité seulement s\'il reste des épisodes sortis non vus ; un épisode vu la remet dans En cours', async () => {
  const { db, catalog } = setup();
  const jan = at(db, catalog, '2026-01-02T10:00:00.000Z');
  await setRelation(jan, LONGUE.id, 'on');
  markWatched(jan, [{ episodeId: epId(1003, 1, 1) }]);
  await setRelation(jan, FINIE.id, 'on');
  markSeason(jan, FINIE.id, 1);

  const later = at(db, catalog, NOW);
  const sh = shelf(later);
  assert.deepEqual(sh.abandoned.map((c) => [c.show.id, c.reason.kind]), [[LONGUE.id, 'lastWatched']]);   // FINIE : terminée, pas abandonnée
  assert.deepEqual(timeline(later).toWatch, []);
  // De côté par inactivité : pas d'À venir pour elle.
  assert.deepEqual(timeline(later).upcoming, []);

  const r = markWatched(later, [{ episodeId: epId(1003, 1, 2) }]);
  assert.equal(r.shows[0]?.status, 'encours');
  assert.equal(r.shows[0]?.relation, 'on');
  assert.deepEqual(timeline(later).toWatch.map((x) => [x.show.id, x.next.id, x.remaining]), [[LONGUE.id, epId(1003, 1, 3), 1]]);
  assert.deepEqual(timeline(later).upcoming.map((x) => x.episode.id), [epId(1003, 2, 1)]);
});

test('reprise (on depuis « de côté ») remet le compteur à zéro', async () => {
  const { db, catalog } = setup();
  await setRelation(at(db, catalog, '2026-01-02T10:00:00.000Z'), LONGUE.id, 'on');
  const ctx = at(db, catalog, NOW);
  const before = await setRelation(ctx, LONGUE.id, 'shelf');   // déjà de côté par inactivité : rien ne change
  assert.equal(before.relation, 'shelf');
  assert.equal((userShow(db, LONGUE.id) as { state: string }).state, 'followed');

  const s = await setRelation(ctx, LONGUE.id, 'on');
  assert.equal(s.relation, 'on');
  assert.equal(s.status, 'encours');
  assert.deepEqual(userShow(db, LONGUE.id), { state: 'followed', addedAt: '2026-01-02T10:00:00.000Z', resumedAt: NOW });

  // Depuis une mise de côté à la main : même reprise.
  await setRelation(ctx, LONGUE.id, 'shelf');
  assert.equal((userShow(db, LONGUE.id) as { state: string }).state, 'shelved');
  const later = at(db, catalog, '2026-11-20T08:00:00.000Z');
  await setRelation(later, LONGUE.id, 'on');
  assert.deepEqual(userShow(db, LONGUE.id), { state: 'followed', addedAt: '2026-01-02T10:00:00.000Z', resumedAt: '2026-11-20T08:00:00.000Z' });
});

test('ne plus suivre conserve les vus ; re-suivre reprend où on en était', async () => {
  const { db, ctx } = setup();
  await setRelation(ctx, SEV.id, 'on');
  markWatched(ctx, [{ episodeId: epId(1001, 1, 1) }, { episodeId: epId(1001, 1, 2) }]);
  const off = await setRelation(ctx, SEV.id, 'none');
  assert.equal(off.relation, 'none');
  assert.equal(off.seen, 2);
  assert.equal(userShow(db, SEV.id), undefined);
  assert.deepEqual(myShows(ctx), []);
  assert.equal(history(ctx, null).items.length, 2);

  const on = await setRelation(ctx, SEV.id, 'on');
  assert.equal(on.next?.id, epId(1001, 1, 3));
  assert.equal(on.seen, 2);
});

test('vu / non vu sur une série non suivie', async () => {
  const { db, catalog, ctx } = setup();
  await catalog.ensureShow(SEV.id);
  const r = markWatched(ctx, [{ episodeId: epId(1001, 1, 1) }]);
  assert.deepEqual(r.marked, [epId(1001, 1, 1)]);
  assert.equal(r.shows[0]?.relation, 'none');
  assert.equal(userShow(db, SEV.id), undefined);
  assert.equal(history(ctx, null).items[0]?.show.name, 'Severance');
});

test('un épisode qui sort aujourd\'hui est sorti ; un épisode futur ou sans date est refusé', async () => {
  const { catalog, ctx } = setup();
  await catalog.ensureShow(SEV.id);
  assert.deepEqual(markWatched(ctx, [{ episodeId: epId(1001, 2, 1) }]).marked, [epId(1001, 2, 1)]);
  assert.throws(() => markWatched(ctx, [{ episodeId: epId(1001, 2, 2) }]), NotAiredError);
  assert.throws(() => markWatched(ctx, [{ episodeId: epId(1001, 2, 3) }]), NotAiredError);
  assert.throws(() => markWatched(ctx, [{ episodeId: 999 }]), NotFoundError);
  // Un lot avec un épisode refusé n'écrit rien.
  assert.throws(() => markWatched(ctx, [{ episodeId: epId(1001, 1, 1) }, { episodeId: epId(1001, 2, 2) }]), NotAiredError);
  assert.equal(history(ctx, null).items.length, 1);
});

test('idempotence de vu / non vu', async () => {
  const { db, catalog, ctx } = setup();
  await catalog.ensureShow(SEV.id);
  const id = epId(1001, 1, 1);
  assert.deepEqual(markWatched(ctx, [{ episodeId: id }]).marked, [id]);
  const later = at(db, catalog, '2026-11-14T12:00:00.000Z');
  assert.deepEqual(markWatched(later, [{ episodeId: id }]).marked, []);
  assert.equal(watchedAt(db, id), NOW);                     // date d'origine conservée
  assert.deepEqual(unmarkWatched(ctx, [id]).removed, [{ episodeId: id, watchedAt: NOW }]);
  assert.deepEqual(unmarkWatched(ctx, [id]).removed, []);
  assert.throws(() => unmarkWatched(ctx, [999]), NotFoundError);
});

test('Annuler une remise en non vu restaure la date d\'origine', async () => {
  const { db, catalog } = setup();
  await catalog.ensureShow(SEV.id);
  const id = epId(1001, 1, 2);
  const oct = at(db, catalog, '2026-10-09T21:15:00.000Z');
  markWatched(oct, [{ episodeId: id }]);
  const ctx = at(db, catalog, NOW);
  const { removed } = unmarkWatched(ctx, [id]);
  assert.deepEqual(removed, [{ episodeId: id, watchedAt: '2026-10-09T21:15:00.000Z' }]);
  assert.deepEqual(markWatched(ctx, removed).marked, [id]);
  assert.equal(watchedAt(db, id), '2026-10-09T21:15:00.000Z');
  // watchedAt imposé remplace aussi la date d'un épisode déjà vu.
  assert.deepEqual(markWatched(ctx, [{ episodeId: id, watchedAt: '2026-10-10T08:00:00.000Z' }]).marked, [id]);
  assert.deepEqual(markWatched(ctx, [{ episodeId: id, watchedAt: '2026-10-10T08:00:00.000Z' }]).marked, []);
});

test('marquer vu ne touche pas à la mise de côté manuelle', async () => {
  const { ctx } = setup();
  await setRelation(ctx, SEV.id, 'shelf');
  const r = markWatched(ctx, [{ episodeId: epId(1001, 1, 1) }]);
  assert.equal(r.shows[0]?.status, 'decote');
  assert.equal(r.shows[0]?.relation, 'shelf');
});

test('tout marquer vu jusqu\'ici : épisodes sortis jusqu\'à celui-ci, dans l\'ordre', async () => {
  const { db, ctx } = setup();
  await setRelation(ctx, SEV.id, 'on');
  markWatched(ctx, [{ episodeId: epId(1001, 1, 2) }]);
  const r = watchedUntil(ctx, SEV.id, epId(1001, 2, 1));
  assert.deepEqual(r.marked, [epId(1001, 1, 1), epId(1001, 1, 3), epId(1001, 2, 1)]);
  assert.equal(r.show.status, 'ajour');
  assert.equal(r.show.next, null);
  // L'ordre saison/numéro se retrouve dans les instants.
  const times = r.marked.map((id) => watchedAt(db, id) as string);
  assert.deepEqual([...times].sort(), times);
  assert.equal(new Set(times).size, 3);
  assert.throws(() => watchedUntil(ctx, SEV.id, epId(1001, 2, 2)), NotAiredError);
  assert.throws(() => watchedUntil(ctx, SEV.id, epId(1002, 1, 1)), NotFoundError);
});

test('coche de saison : épisodes sortis de la saison', async () => {
  const { catalog, ctx } = setup();
  await catalog.ensureShow(SEV.id);
  await catalog.ensureShow(LONGUE.id);
  assert.deepEqual(markSeason(ctx, SEV.id, 2).marked, [epId(1001, 2, 1)]);
  assert.deepEqual(markSeason(ctx, SEV.id, 2).marked, []);
  assert.throws(() => markSeason(ctx, SEV.id, 3), NotFoundError);
  assert.throws(() => markSeason(ctx, LONGUE.id, 2), NotAiredError);
  assert.throws(() => markSeason(ctx, 4242, 1), NotFoundError);
});

test('historique : toutes séries, du plus récent au plus ancien, pagination par curseur', async () => {
  const { db, catalog } = setup();
  await catalog.ensureShow(SEV.id);
  await catalog.ensureShow(FINIE.id);
  markSeason(at(db, catalog, '2026-11-01T10:00:00.000Z'), FINIE.id, 1);
  markSeason(at(db, catalog, '2026-11-10T23:30:00.000Z'), SEV.id, 1);
  const ctx = at(db, catalog, NOW);
  const p1 = history(ctx, null, 2);
  assert.deepEqual(p1.items.map((i) => i.episodeId), [epId(1001, 1, 3), epId(1001, 1, 2)]);
  assert.equal(p1.items[0]?.watchedDay, '2026-11-11');      // 23 h 30 UTC = lendemain à Paris
  assert.ok(p1.next);
  const { decodeCursor } = await import('../src/usecases/lists.ts');
  const p2 = history(ctx, decodeCursor(p1.next), 2);
  assert.deepEqual(p2.items.map((i) => i.episodeId), [epId(1001, 1, 1), epId(1002, 1, 2)]);
  const p3 = history(ctx, decodeCursor(p2.next as string), 2);
  assert.deepEqual(p3.items.map((i) => i.episodeId), [epId(1002, 1, 1)]);
  assert.equal(p3.next, null);
});

test('fiche série : saisons, plateformes groupées, relation et statut du milieu', async () => {
  const { db, catalog, ctx } = setup();
  const d = await showDetail(ctx, LONGUE.id);
  assert.deepEqual(catalog.calls, ['ensureShow 1003', 'ensureProviders 1003 FR']);
  assert.equal(d.relation, 'none');
  assert.equal(d.wouldBeStatus, 'encours');
  assert.equal(d.seasonCount, 2);
  assert.equal(d.year, 2025);
  assert.equal(d.statusLabel, 'en diffusion');
  assert.deepEqual(d.seasons.map((s) => [s.number, s.count, s.aired, s.seen, s.firstAirDate]), [[1, 3, 3, 0, '2025-12-01'], [2, 1, 0, 0, '2026-11-27']]);
  assert.deepEqual(d.providers.groups.map((g) => [g.label, g.items.map((i) => i.id)]), [['Saison 1', [8, 119]], ['Saison 2', [119]]]);

  // TMDB injoignable : la fiche est servie depuis le cache.
  catalog.offline = true;
  assert.equal((await showDetail(ctx, LONGUE.id)).name, 'Longue');
  await assert.rejects(showDetail(ctx, SEV.id), UpstreamError);
  catalog.offline = false;
  await assert.rejects(showDetail(ctx, 4242), NotFoundError);
  void db;
});

test('vue saison : état vu, sorti, VO, untilCount, plateformes de la saison', async () => {
  const { ctx } = setup();
  await setRelation(ctx, SEV.id, 'on');
  markWatched(ctx, [{ episodeId: epId(1001, 1, 2) }]);
  const s = await seasonDetail(ctx, SEV.id, 2);
  assert.deepEqual(s.season, { number: 2, name: 'Saison 2', overview: '', airDate: '2026-11-13', posterPath: null, count: 3, aired: 1, seen: 0 });
  assert.deepEqual(s.providers.map((p) => p.id), [350]);
  assert.deepEqual(s.episodes.map((e) => [e.number, e.aired, e.titleIsVo, e.untilCount]), [[1, true, true, 3], [2, false, false, 3], [3, false, false, 3]]);
  const s1 = await seasonDetail(ctx, SEV.id, 1);
  assert.deepEqual(s1.episodes.map((e) => [e.watchedDay, e.untilCount]), [[null, 1], ['2026-11-13', 1], [null, 2]]);
  await assert.rejects(seasonDetail(ctx, SEV.id, 9), NotFoundError);
});

test('Mes séries et recherche : même ligne, relation, x/y vus', async () => {
  const { db, catalog, ctx } = setup();
  await setRelation(ctx, SEV.id, 'on');
  await setRelation(ctx, FINIE.id, 'shelf');
  markWatched(ctx, [{ episodeId: epId(1001, 1, 1) }]);
  assert.deepEqual(myShows(ctx).map((r) => [r.name, r.relation, r.seen, r.total, r.seasonCount, r.statusLabel, r.year]),
    [['Finie', 'shelf', 0, 2, 1, 'terminée', 2025], ['Severance', 'on', 1, 6, 2, 'en diffusion', 2026]]);

  const res = await search(ctx, 'e');
  const byId = new Map(res.map((r) => [r.id, r]));
  assert.equal(byId.get(SEV.id)?.relation, 'on');
  assert.equal(byId.get(SEV.id)?.seen, 1);
  assert.equal(byId.get(LONGUE.id)?.cached, false);
  assert.equal(byId.get(LONGUE.id)?.relation, 'none');
  assert.equal(byId.get(LONGUE.id)?.seen, null);
  catalog.offline = true;
  await assert.rejects(search(ctx, 'x'), UpstreamError);
  void db;
});

test('série non suivie : status null, relation et wouldBeStatus seuls significatifs', async () => {
  const { catalog, db } = setup('2026-01-10T12:00:00.000Z');
  const early = at(db, catalog, '2026-01-10T12:00:00.000Z');
  await setRelation(early, LONGUE.id, 'on');
  markWatched(early, [{ episodeId: epId(1003, 1, 1) }]);
  const late = at(db, catalog, NOW);
  const off = await setRelation(late, LONGUE.id, 'none');
  assert.equal(off.relation, 'none');
  assert.equal(off.status, null);
  assert.equal(off.wouldBeStatus, 'encours');
  assert.equal((await showDetail(late, LONGUE.id)).status, null);
  const row = (await search(late, 'e')).find((r) => r.id === LONGUE.id);
  assert.equal(row?.relation, 'none');
  assert.equal(row?.status, null);
  assert.equal(row?.seen, 1);
});

test('épisode vu puis retiré chez TMDB (removed_at) : hors statut et saisons, gardé dans l\'historique', async () => {
  const { db, ctx } = setup();
  await setRelation(ctx, SEV.id, 'on');
  const e2 = epId(1001, 1, 2);
  watchedUntil(ctx, SEV.id, epId(1001, 1, 3));
  // Le catalogue garde un épisode vu disparu chez TMDB, marqué retiré.
  db.prepare("UPDATE episodes SET removed_at = '2026-11-14T00:00:00.000Z' WHERE id = ?").run(e2);

  const detail = await showDetail(ctx, SEV.id);
  assert.equal(detail.total, 5);
  assert.equal(detail.seen, 2);
  assert.deepEqual(detail.seasons.map((s) => [s.number, s.count, s.seen]), [[1, 2, 2], [2, 3, 0]]);
  const s1 = await seasonDetail(ctx, SEV.id, 1);
  assert.deepEqual(s1.episodes.map((e) => e.number), [1, 3]);
  assert.equal(s1.season.count, 2);

  // L'historique le garde, avec son numéro d'origine.
  const h = history(ctx, null).items.find((i) => i.episodeId === e2);
  assert.equal(h?.number, 2);
  assert.equal(h?.retired, true);

  // Remis en non vu : il ne redevient pas le prochain épisode.
  unmarkWatched(ctx, [e2]);
  const t = timeline(ctx).toWatch.find((x) => x.show.id === SEV.id);
  assert.equal(t?.next.id, epId(1001, 2, 1));
  assert.equal(t?.remaining, 1);
});
