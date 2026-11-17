import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type StatShow, type StatWatch, computeStats, nightOf, periodOf } from '../src/domain/stats.ts';

const TZ = 'Europe/Paris';
const TODAY = '2026-11-16';
const OPTS = { timezone: TZ, period: periodOf('all', TODAY, '2016-01-01') };
const during = (range: string) => ({ timezone: TZ, period: periodOf(range, TODAY, '2016-01-01') });

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

test('périodes : tout par année, une année ou 1 an / 6 mois par mois, 3 mois par semaine, 1 mois par jour', () => {
  assert.deepEqual(periodOf('all', TODAY, '2016-05-02'), { from: null, to: TODAY, unit: 'year', keys: ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'] });
  assert.deepEqual(periodOf('all', TODAY, null).keys, ['2026']);
  const y = periodOf('2024', TODAY, null);
  assert.deepEqual([y.from, y.to, y.unit, y.keys.length, y.keys[0], y.keys[11]], ['2024-01-01', '2024-12-31', 'month', 12, '2024-01', '2024-12']);
  const a = periodOf('1y', TODAY, null);
  assert.deepEqual([a.from, a.keys.length, a.keys[0], a.keys[11]], ['2025-12-01', 12, '2025-12', '2026-11']);
  assert.deepEqual(periodOf('6m', TODAY, null).keys, ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  const w = periodOf('3m', TODAY, null);                   // 16/11/2026 est un lundi
  assert.deepEqual([w.unit, w.keys.length, w.keys[0], w.keys[12], w.from], ['week', 13, '2026-08-24', '2026-11-16', '2026-08-24']);
  const d = periodOf('1m', TODAY, null);
  assert.deepEqual([d.unit, d.keys.length, d.keys[0], d.keys[29]], ['day', 30, '2026-10-18', TODAY]);
});

test('période : visionnages filtrés par jour local, histogramme des marques seules, séries commencées / terminées dans la période', () => {
  const ws = [
    w(1, 1, '2024-12-31T23:30:00Z'),                    // 1er janvier 2025 à Paris
    w(1, 1, '2024-06-15T20:00:00Z', { single: false }),
    w(2, 1, '2024-03-01T20:00:00Z'),
    w(2, 1, '2025-02-01T20:00:00Z'),
  ];
  const shows = [show(1, { status: 'terminee' }), show(2, { status: 'terminee' })];
  const y24 = computeStats(ws, shows, during('2024'));
  assert.equal(y24.episodes, 2);
  assert.deepEqual(y24.histogram.buckets.filter((b) => b.episodes).map((b) => [b.key, b.episodes]), [['2024-03', 1]]);   // le lot ne compte pas
  assert.deepEqual([y24.started, y24.finished], [2, 0]);   // série 1 commencée en juin 2024, finie en 2025
  const y25 = computeStats(ws, shows, during('2025'));
  assert.deepEqual([y25.episodes, y25.started, y25.finished], [2, 0, 2]);
  const all = computeStats(ws, shows, OPTS);
  assert.deepEqual(all.histogram.buckets.filter((b) => b.episodes).map((b) => [b.key, b.episodes]), [['2024', 1], ['2025', 2]]);
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
