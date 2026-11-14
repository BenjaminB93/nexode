import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, localDate, todayIn } from '../src/domain/dates.ts';

test('localDate : jour local dans le fuseau donné', () => {
  assert.equal(localDate('2026-11-13T23:30:00.000Z', 'Europe/Paris'), '2026-11-14');
  assert.equal(localDate('2026-11-13T23:30:00.000Z', 'UTC'), '2026-11-13');
  assert.equal(localDate('2026-11-14T03:00:00.000Z', 'America/New_York'), '2026-11-13');
  // Heure d'été : 22 h 30 UTC le 1er juillet = 0 h 30 à Paris le 2.
  assert.equal(localDate('2026-07-01T22:30:00.000Z', 'Europe/Paris'), '2026-07-02');
});

test('localDate refuse un instant invalide', () => {
  assert.throws(() => localDate('pas une date', 'UTC'), RangeError);
});

test('todayIn', () => {
  assert.equal(todayIn('Europe/Paris', new Date('2026-12-31T23:10:00Z')), '2027-01-01');
});

test('daysBetween compte des jours calendaires', () => {
  assert.equal(daysBetween('2026-11-13', '2026-11-13'), 0);
  assert.equal(daysBetween('2026-11-12', '2026-11-13'), 1);
  assert.equal(daysBetween('2026-11-13', '2026-11-12'), -1);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);   // passage à l'heure d'été sans effet
  assert.equal(daysBetween('2025-11-13', '2026-11-13'), 365);
});
