import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type EpisodeLike, type Follow, type StatusInput, computeStatus, relationOf, wouldBeStatus } from '../src/domain/series.ts';

const TODAY = '2026-11-13';

// Épisodes (saison, numéro, date) ; id = saison * 100 + numéro.
function eps(...list: [number, number, string | null][]): EpisodeLike[] {
  return list.map(([season, number, airDate]) => ({ id: season * 100 + number, season, number, airDate }));
}
const followed = (addedAt = '2026-11-01T10:00:00.000Z', resumedAt: string | null = null): Follow => ({ state: 'followed', addedAt, resumedAt });
const shelved = (addedAt = '2026-11-01T10:00:00.000Z'): Follow => ({ state: 'shelved', addedAt, resumedAt: null });

function input(over: Partial<StatusInput<EpisodeLike>> = {}): StatusInput<EpisodeLike> {
  return {
    episodes: eps([1, 1, '2026-10-01'], [1, 2, '2026-10-08'], [1, 3, '2026-10-15']),
    watched: new Map(),
    showStatus: 'returning',
    follow: followed(),
    today: TODAY,
    timezone: 'Europe/Paris',
    shelveAfterDays: 30,
    ...over,
  };
}

test('prochain épisode, restants, vus et total ; tri saison/numéro quel que soit l\'ordre reçu', () => {
  const r = computeStatus(input({
    episodes: eps([2, 1, '2026-11-20'], [1, 2, '2026-10-08'], [1, 1, '2026-10-01'], [2, 2, null]),
    watched: new Map([[101, '2026-11-05T20:00:00.000Z']]),
  }));
  assert.equal(r.status, 'encours');
  assert.equal(r.next?.id, 102);
  assert.equal(r.remaining, 1);
  assert.deepEqual(r.future.map((e) => e.id), [201]);   // date inconnue : ni sorti ni à venir
  assert.equal(r.seen, 1);
  assert.equal(r.total, 4);
  assert.equal(r.started, true);
  assert.equal(r.lastWatchedDay, '2026-11-05');
});

test('un épisode qui sort aujourd\'hui est sorti', () => {
  const r = computeStatus(input({ episodes: eps([1, 1, TODAY]) }));
  assert.equal(r.next?.id, 101);
  assert.equal(r.remaining, 1);
  assert.deepEqual(r.future, []);
});

test('les vus d\'autres séries dans la map sont ignorés', () => {
  const r = computeStatus(input({ watched: new Map([[999, '2026-11-12T20:00:00.000Z']]) }));
  assert.equal(r.seen, 0);
  assert.equal(r.started, false);
});

test('mise de côté à la main : decote, même à jour', () => {
  const all = new Map([[101, '2026-11-10T20:00:00.000Z'], [102, '2026-11-10T21:00:00.000Z'], [103, '2026-11-10T22:00:00.000Z']]);
  assert.equal(computeStatus(input({ watched: all })).status, 'ajour');
  assert.equal(computeStatus(input({ watched: all, follow: shelved() })).status, 'decote');
});

test('seuil dépassé seulement s\'il reste des épisodes sortis non vus', () => {
  const old = '2026-09-01T20:00:00.000Z';
  const base = { follow: followed('2026-08-01T10:00:00.000Z') };
  // Tout vu il y a longtemps, la suite n'est pas sortie : à jour, pas abandonnée.
  const upToDate = computeStatus(input({ ...base, episodes: eps([1, 1, '2026-08-20'], [2, 1, '2027-01-10']), watched: new Map([[101, old]]) }));
  assert.equal(upToDate.status, 'ajour');
  // Un épisode sorti non vu et 73 jours sans activité : de côté.
  const stale = computeStatus(input({ ...base, episodes: eps([1, 1, '2026-08-20'], [1, 2, '2026-08-27']), watched: new Map([[101, old]]) }));
  assert.equal(stale.status, 'decote');
});

test('nouvelle saison d\'une série vue jusqu\'au bout : le seuil part de la sortie du premier épisode non vu', () => {
  const base = { follow: followed('2026-08-01T10:00:00.000Z'), watched: new Map([[101, '2026-09-01T20:00:00.000Z']]) };
  const at = (day: string) => computeStatus(input({ ...base, episodes: eps([1, 1, '2026-08-20'], [2, 1, day], [2, 2, '2026-11-13']) })).status;
  assert.equal(at('2026-11-13'), 'encours');   // sortie aujourd'hui
  assert.equal(at('2026-10-14'), 'encours');   // 30 jours
  assert.equal(at('2026-10-13'), 'decote');    // 31 jours sans regarder la nouvelle saison
});

test('seuil : 30 jours pile = en cours, 31 = de côté ; paramétrable', () => {
  const at = (day: string) => computeStatus(input({ watched: new Map([[101, `${day}T12:00:00.000Z`]]), follow: followed('2026-01-01T00:00:00.000Z') })).status;
  assert.equal(at('2026-10-14'), 'encours');   // 30 jours avant le 13/11
  assert.equal(at('2026-10-13'), 'decote');    // 31 jours
  const r = computeStatus(input({ watched: new Map([[101, '2026-10-13T12:00:00.000Z']]), follow: followed('2026-01-01T00:00:00.000Z'), shelveAfterDays: 60 }));
  assert.equal(r.status, 'encours');
});

test('référence d\'inactivité = max(dernier vu, ajout, reprise)', () => {
  const longAgo = followed('2026-01-01T00:00:00.000Z');
  assert.equal(computeStatus(input({ follow: longAgo })).status, 'decote');
  assert.equal(computeStatus(input({ follow: followed('2026-01-01T00:00:00.000Z', '2026-11-12T08:00:00.000Z') })).status, 'encours');
  assert.equal(computeStatus(input({ follow: followed('2026-11-01T00:00:00.000Z') })).status, 'encours');
});

test('fuseau : un visionnage à 23 h 30 UTC compte le lendemain à Paris', () => {
  const w = new Map([[101, '2026-10-13T23:30:00.000Z']]);   // 14/10 à 1 h 30 à Paris
  const follow = followed('2026-01-01T00:00:00.000Z');
  const paris = computeStatus(input({ watched: w, follow }));
  assert.equal(paris.lastWatchedDay, '2026-10-14');
  assert.equal(paris.status, 'encours');                     // 30 jours
  const utc = computeStatus(input({ watched: w, follow, timezone: 'UTC' }));
  assert.equal(utc.lastWatchedDay, '2026-10-13');
  assert.equal(utc.status, 'decote');                        // 31 jours
});

test('terminée vs à jour', () => {
  const all = new Map([[101, '2026-11-10T20:00:00.000Z'], [102, '2026-11-10T20:00:01.000Z'], [103, '2026-11-10T20:00:02.000Z']]);
  assert.equal(computeStatus(input({ watched: all, showStatus: 'ended' })).status, 'terminee');
  assert.equal(computeStatus(input({ watched: all, showStatus: 'canceled' })).status, 'terminee');
  assert.equal(computeStatus(input({ watched: all, showStatus: 'returning' })).status, 'ajour');
  // Finie selon TMDB mais un épisode reste annoncé : à jour.
  const withFuture = eps([1, 1, '2026-10-01'], [1, 2, '2026-12-01']);
  assert.equal(computeStatus(input({ episodes: withFuture, watched: new Map([[101, '2026-11-10T20:00:00.000Z']]), showStatus: 'ended' })).status, 'ajour');
});

test('relationOf', () => {
  assert.equal(relationOf(null, 'encours'), 'none');
  assert.equal(relationOf(followed(), 'encours'), 'on');
  assert.equal(relationOf(followed(), 'ajour'), 'on');
  assert.equal(relationOf(followed(), 'decote'), 'shelf');   // inactivité
  assert.equal(relationOf(shelved(), 'decote'), 'shelf');
});

test('wouldBeStatus : statut de la position du milieu du sélecteur', () => {
  const now = '2026-11-13T12:00:00.000Z';
  // Pas suivie, épisodes non vus : « En cours » (suivre = reprise maintenant).
  assert.equal(wouldBeStatus(input({ follow: null }), now), 'encours');
  // De côté par inactivité : revenir dessus remet le compteur à zéro → « En cours ».
  assert.equal(wouldBeStatus(input({ follow: followed('2026-01-01T00:00:00.000Z') }), now), 'encours');
  // Mise de côté à la main alors que tout est vu : « À jour ».
  const all = new Map([[101, '2026-11-10T20:00:00.000Z'], [102, '2026-11-10T20:00:01.000Z'], [103, '2026-11-10T20:00:02.000Z']]);
  assert.equal(wouldBeStatus(input({ follow: shelved(), watched: all }), now), 'ajour');
  assert.equal(wouldBeStatus(input({ follow: null, watched: all, showStatus: 'ended' }), now), 'terminee');
  // Suivie : son statut réel.
  assert.equal(wouldBeStatus(input(), now), 'encours');
});

test('un épisode vu dont la date repasse dans le futur ne compte pas dans future', () => {
  // TMDB a corrigé la date de E3 après qu'il a été vu.
  const episodes = eps([1, 1, '2026-10-01'], [1, 2, '2026-10-08'], [1, 3, '2026-12-01']);
  const all = new Map([[101, '2026-11-10T20:00:00.000Z'], [102, '2026-11-10T20:00:01.000Z'], [103, '2026-11-10T20:00:02.000Z']]);
  const r = computeStatus(input({ episodes, watched: all, showStatus: 'ended' }));
  assert.deepEqual(r.future, []);
  assert.equal(r.status, 'terminee');
});
