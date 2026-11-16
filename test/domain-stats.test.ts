import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type StatShow, type StatWatch, computeStats, nightOf } from '../src/domain/stats.ts';

const TZ = 'Europe/Paris';
const OPTS = { timezone: TZ, today: '2026-11-16' };

let nextId = 1;
const w = (showId: number, season: number, watchedAt: string, o: Partial<StatWatch> = {}): StatWatch =>
  ({ episodeId: nextId++, showId, season, airDate: null, runtime: 40, watchedAt, single: true, ...o });
const show = (id: number, o: Partial<StatShow> = {}): StatShow =>
  ({ id, relation: 'on', status: 'encours', seen: 1, remaining: 3, airedBySeason: new Map(), ...o });

test('nuit : un visionnage avant 5 h compte pour la veille (heure locale)', () => {
  assert.equal(nightOf('2026-03-10T22:30:00.000Z', TZ), '2026-03-10');   // 23 h 30 à Paris
  assert.equal(nightOf('2026-03-11T02:30:00.000Z', TZ), '2026-03-10');   // 3 h 30
  assert.equal(nightOf('2026-03-11T04:30:00.000Z', TZ), '2026-03-11');   // 5 h 30
});

test('périmètre : une série qu\'on ne suit plus ne compte nulle part ; durée inconnue non comptée', () => {
  const r = computeStats([w(1, 1, '2026-11-01T20:00:00Z'), w(1, 1, '2026-11-01T21:00:00Z', { runtime: null }), w(9, 1, '2026-11-01T20:00:00Z')],
    [show(1)], OPTS);
  assert.equal(r.episodes, 2);
  assert.equal(r.minutes, 40);
  assert.equal(r.started, 1);
});

test('binge : marques seules d\'une même série dans une même nuit, au moins 3 ; le rattrapage compte les lots', () => {
  const night = ['2026-10-01T19:00:00Z', '2026-10-01T21:00:00Z', '2026-10-02T01:00:00Z'];   // 21 h, 23 h, 3 h
  const lot = Array.from({ length: 10 }, (_, i) => w(2, 1, `2026-09-01T10:00:00.00${i}Z`, { single: false }));
  const r = computeStats([...night.map((at) => w(1, 1, at)), ...lot], [show(1), show(2)], OPTS);
  assert.deepEqual(r.binge, { showId: 1, night: '2026-10-01', episodes: 3 });
  assert.deepEqual(r.catchUp, { showId: 2, night: '2026-09-01', episodes: 10 });
  const two = computeStats(night.slice(0, 2).map((at) => w(1, 1, at)), [show(1)], OPTS);
  assert.equal(two.binge, null);
  assert.equal(two.catchUp, null);
});

test('saison dévorée : tous les épisodes sortis marqués seuls, le moins de nuits, au moins 4 épisodes', () => {
  const ws: StatWatch[] = [];
  const season = (showId: number, s: number, ats: string[], single = true) => {
    const list = ats.map((at) => w(showId, s, at, { single }));
    ws.push(...list);
    return list.map((x) => x.episodeId);
  };
  const a = season(1, 1, ['2026-01-01T20:00:00Z', '2026-01-02T20:00:00Z', '2026-01-03T20:00:00Z', '2026-01-04T20:00:00Z']);
  const b = season(1, 2, ['2026-02-01T20:00:00Z', '2026-02-01T21:00:00Z', '2026-02-02T20:00:00Z', '2026-02-02T21:00:00Z']);
  const lot = season(2, 1, ['2026-03-01T20:00:00Z', '2026-03-01T20:00:01Z', '2026-03-01T20:00:02Z', '2026-03-01T20:00:03Z'], false);
  const short = season(3, 1, ['2026-04-01T20:00:00Z', '2026-04-01T21:00:00Z', '2026-04-01T22:00:00Z']);
  const r = computeStats(ws, [
    show(1, { airedBySeason: new Map([[1, a], [2, b]]) }),
    show(2, { airedBySeason: new Map([[1, lot]]) }),
    show(3, { airedBySeason: new Map([[1, short]]) }),
  ], OPTS);
  assert.deepEqual(r.fastestSeason, { showId: 1, season: 2, episodes: 4, days: 2 });
  // Un épisode sorti non vu : la saison ne compte pas.
  const r2 = computeStats(ws, [show(1, { airedBySeason: new Map([[2, [...b, 999]]]) })], OPTS);
  assert.equal(r2.fastestSeason, null);
});

test('abandon le plus rageant : série de côté commencée, le moins d\'épisodes restants', () => {
  const r = computeStats([], [
    show(1, { relation: 'on', remaining: 1 }),
    show(2, { relation: 'shelf', remaining: 5 }),
    show(3, { relation: 'shelf', remaining: 2, seen: 4 }),
    show(4, { relation: 'shelf', remaining: 2, seen: 10 }),
    show(5, { relation: 'shelf', remaining: 1, seen: 0 }),
  ], OPTS);
  assert.deepEqual(r.closestEnd, { showId: 4, remaining: 2 });
});

test('dès la sortie : le jour même ou le lendemain, marques seules ; null sans aucune marque seule', () => {
  const r = computeStats([
    w(1, 1, '2026-10-01T20:00:00Z', { airDate: '2026-10-01' }),
    w(1, 1, '2026-10-02T20:00:00Z', { airDate: '2026-10-01' }),
    w(1, 1, '2026-10-03T20:00:00Z', { airDate: '2026-10-01' }),
    w(1, 1, '2026-10-01T20:00:00Z', { airDate: '2026-10-01', single: false }),
  ], [show(1)], OPTS);
  assert.equal(r.sameDay, 2);
  assert.equal(computeStats([w(1, 1, '2026-10-01T20:00:00Z', { single: false })], [show(1)], OPTS).sameDay, null);
});

test('mois : les 12 derniers, marques seules, en heure locale', () => {
  const r = computeStats([
    w(1, 1, '2026-10-31T23:30:00Z'),                    // 1er novembre à Paris
    w(1, 1, '2025-12-15T20:00:00Z'),
    w(1, 1, '2025-11-15T20:00:00Z'),                    // hors fenêtre
    w(1, 1, '2026-11-02T20:00:00Z', { single: false }),
  ], [show(1)], OPTS);
  assert.equal(r.months.length, 12);
  assert.deepEqual(r.months[0], { month: '2025-12', episodes: 1 });
  assert.deepEqual(r.months[11], { month: '2026-11', episodes: 1 });
});

test('fidélité : série en cours dont le premier visionnage marqué seul est le plus ancien', () => {
  const r = computeStats([
    w(1, 1, '2016-01-01T20:00:00Z', { single: false }),   // date de marquage en lot : ne date rien
    w(1, 1, '2020-01-01T20:00:00Z'),
    w(2, 1, '2019-01-01T20:00:00Z'),
    w(3, 1, '2018-01-01T20:00:00Z'),
  ], [show(1), show(2), show(3, { relation: 'shelf' })], OPTS);
  assert.deepEqual(r.loyalty, { showId: 2, since: '2019-01-01T20:00:00Z' });
});
