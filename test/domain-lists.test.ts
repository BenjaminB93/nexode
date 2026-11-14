import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ShowEntry, buildShelf, buildToWatch, buildUpcoming } from '../src/domain/lists.ts';
import { providerGroups } from '../src/domain/providers.ts';
import { type EpisodeLike, type Follow, computeStatus } from '../src/domain/series.ts';

const TODAY = '2026-11-13';
type Show = { id: number; name: string };

// Série de test : id, nom, dates des épisodes de la saison 1, vus (numéros → instant), suivi.
function entry(id: number, name: string, dates: (string | null)[], watched: Record<number, string>, follow: Follow | null): ShowEntry<Show, EpisodeLike> {
  const episodes = dates.map((airDate, i) => ({ id: id * 100 + i + 1, season: 1, number: i + 1, airDate }));
  const w = new Map(Object.entries(watched).map(([n, at]) => [id * 100 + Number(n), at]));
  const info = computeStatus({ episodes, watched: w, showStatus: 'returning', follow, today: TODAY, timezone: 'Europe/Paris', shelveAfterDays: 30 });
  return { show: { id, name }, follow, info };
}
const f = (addedAt: string, state: Follow['state'] = 'followed'): Follow => ({ state, addedAt, resumedAt: null });

test('À regarder : séries en cours, prochain épisode le plus ancien en haut, puis par nom', () => {
  const list = buildToWatch([
    entry(1, 'Zeta', ['2026-11-10'], {}, f('2026-11-01T00:00:00Z')),
    entry(2, 'Alpha', ['2026-11-01', '2026-11-12'], { 1: '2026-11-05T20:00:00Z' }, f('2026-11-01T00:00:00Z')),
    entry(3, 'Beta', ['2026-11-10'], {}, f('2026-11-01T00:00:00Z')),
    entry(4, 'Pas suivie', ['2026-01-01'], {}, null),
    entry(5, 'À jour', ['2026-11-01'], { 1: '2026-11-02T20:00:00Z' }, f('2026-11-01T00:00:00Z')),
    entry(6, 'Abandonnée', ['2026-01-01', '2026-01-08'], { 1: '2026-02-01T20:00:00Z' }, f('2026-01-01T00:00:00Z')),
    entry(7, 'À la main', ['2026-11-01'], {}, f('2026-11-01T00:00:00Z', 'shelved')),
  ]);
  assert.deepEqual(list.map((x) => [x.show.name, x.next.number, x.remaining]), [['Beta', 1, 1], ['Zeta', 1, 1], ['Alpha', 2, 1]]);
});

test('À regarder : upNext = sortis non vus après next, par saison puis numéro, 3 au plus', () => {
  // Reçus dans le désordre ; 102 vu, 104 sans date, 204 futur.
  const ep = (season: number, number: number, airDate: string | null): EpisodeLike => ({ id: season * 100 + number, season, number, airDate });
  const episodes = [
    ep(2, 4, '2026-11-20'), ep(2, 3, '2026-11-12'), ep(1, 4, null), ep(2, 1, '2026-11-01'),
    ep(1, 3, '2026-10-15'), ep(2, 2, '2026-11-05'), ep(1, 2, '2026-10-08'), ep(1, 1, '2026-10-01'),
  ];
  const follow = f('2026-11-01T00:00:00Z');
  const info = computeStatus({ episodes, watched: new Map([[102, '2026-11-10T20:00:00Z']]), showStatus: 'returning', follow, today: TODAY, timezone: 'Europe/Paris', shelveAfterDays: 30 });
  const [x] = buildToWatch([{ show: { id: 1, name: 'A' }, follow, info }]);
  assert.equal(x?.next.id, 101);
  assert.deepEqual(x?.upNext.map((e) => e.id), [103, 201, 202]);
  assert.equal(x?.remaining, 5);

  const last = buildToWatch([entry(2, 'B', ['2026-11-01', '2026-11-20'], {}, follow)]);
  assert.deepEqual(last.map((y) => [y.next.number, y.upNext]), [[1, []]]);
});

test('À venir : épisodes datés des séries suivies hors « de côté », une carte par série et par jour', () => {
  const list = buildUpcoming([
    entry(1, 'A', ['2026-11-01', '2026-11-20', '2026-11-27', '2026-11-27', '2026-12-04'], {}, f('2026-11-01T00:00:00Z')),
    entry(2, 'B', ['2026-11-25'], {}, f('2026-11-01T00:00:00Z')),
    entry(3, 'De côté', ['2026-11-01', '2026-11-18'], {}, f('2026-11-01T00:00:00Z', 'shelved')),
    entry(4, 'Pas suivie', ['2026-11-19'], {}, null),
    entry(5, 'À jour', ['2026-11-01', '2026-11-20'], { 1: '2026-11-02T20:00:00Z' }, f('2026-11-01T00:00:00Z')),
  ]);
  assert.deepEqual(list.map((x) => `${x.show.name}${x.episode.number}+${x.more}@${x.episode.airDate}`),
    ['A2+0@2026-11-20', 'À jour2+0@2026-11-20', 'B1+0@2026-11-25', 'A3+1@2026-11-27', 'A5+0@2026-12-04']);
});

test('À venir : au plus perShow épisodes par série', () => {
  const list = buildUpcoming([entry(1, 'A', ['2026-11-01', '2026-11-20', '2026-11-27', '2026-11-27', '2026-12-04'], {}, f('2026-11-01T00:00:00Z'))], 3);
  assert.deepEqual(list.map((x) => `${x.episode.number}+${x.more}`), ['2+0', '3+1']);
});

test('De côté : Pas commencées (même à la main) / Abandonnées, avec le motif', () => {
  const { notStarted, abandoned } = buildShelf([
    entry(1, 'Vieille', ['2026-01-01'], {}, f('2026-02-01T00:00:00Z')),
    entry(2, 'Plus tard', ['2026-01-01'], {}, f('2026-11-10T00:00:00Z', 'shelved')),
    entry(3, 'Lâchée tôt', ['2026-01-01', '2026-01-08'], { 1: '2026-03-01T20:00:00Z' }, f('2026-01-01T00:00:00Z')),
    entry(4, 'Lâchée tard', ['2026-01-01', '2026-01-08'], { 1: '2026-09-01T20:00:00Z' }, f('2026-01-01T00:00:00Z')),
    entry(5, 'À jour à la main', ['2026-01-01'], { 1: '2026-11-12T20:00:00Z' }, f('2026-01-01T00:00:00Z', 'shelved')),
    entry(6, 'En cours', ['2026-11-01'], {}, f('2026-11-01T00:00:00Z')),
  ]);
  assert.deepEqual(notStarted.map((c) => [c.show.name, c.reason.kind]), [['Plus tard', 'manual'], ['Vieille', 'added']]);
  assert.deepEqual(abandoned.map((c) => [c.show.name, c.reason.kind]),
    [['À jour à la main', 'manual'], ['Lâchée tard', 'lastWatched'], ['Lâchée tôt', 'lastWatched']]);
  assert.deepEqual(abandoned[1]?.reason, { kind: 'lastWatched', at: '2026-09-01T20:00:00Z', day: '2026-09-01' });
  assert.deepEqual(notStarted[1]?.reason, { kind: 'added', at: '2026-02-01T00:00:00Z' });
  assert.equal(abandoned[0]?.next, null);
  assert.equal(abandoned[1]?.next?.number, 2);
});

test('providerGroups : saisons consécutives identiques fusionnées, libellés seulement si plusieurs groupes', () => {
  const p = (id: number) => ({ id, name: `P${id}`, logoPath: null });
  assert.deepEqual(providerGroups([{ season: 1, items: [p(1)] }, { season: 2, items: [p(1)] }]).map((g) => [g.label, g.from, g.to]),
    [[null, 1, 2]]);
  const groups = providerGroups([
    { season: 3, items: [p(2)] },
    { season: 1, items: [p(1), p(2)] },
    { season: 2, items: [p(2)] },
    { season: 4, items: [] },
    { season: 5, items: [p(2)] },
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((i) => i.id)]),
    [['Saison 1', [1, 2]], ['Saisons 2–3', [2]], ['Saison 5', [2]]]);
  assert.deepEqual(providerGroups([{ season: 1, items: [] }]), []);
});

test('plateformes : repli sur la série quand aucune saison n\'est renseignée (Disney+ en France), pas sinon', async () => {
  const { withShowFallback, providerGroups } = await import('../src/domain/providers.ts');
  const disney = [{ id: 337, name: 'Disney Plus', logoPath: null }];
  const empty = [{ season: 1, items: [] }, { season: 2, items: [] }];
  assert.deepEqual(providerGroups(withShowFallback(empty, disney)), [{ from: 1, to: 2, label: null, items: disney }]);
  const apple = [{ id: 350, name: 'Apple TV', logoPath: null }];
  const partial = [{ season: 1, items: apple }, { season: 2, items: [] }];
  assert.deepEqual(withShowFallback(partial, disney), partial, 'saison 2 pas encore sortie : reste vide');
  assert.deepEqual(withShowFallback(empty, []), empty);
});
