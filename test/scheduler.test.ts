import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Timers, createScheduler, nextRun, zonedToUtc } from '../src/infra/scheduler.ts';

const PARIS = 'Europe/Paris';
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const daily = (time: string, timeZone = PARIS) => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return { every: 'day' as const, hour, minute, timeZone };
};

// Horloge et minuteurs simulés : advance() déclenche les minuteurs échus dans l'ordre et laisse les promesses avancer.
// Les minuteurs suivent un temps monotone (mono) ; setNow() corrige seulement l'horloge murale, comme NTP.
function fakeTimers(start: string) {
  let mono = 0;
  let offset = at(start);
  let seq = 0;
  const pending = new Map<number, { due: number; fn: () => void }>();
  const delays: number[] = [];
  const timers: Timers = {
    now: () => mono + offset,
    setTimeout(fn, ms) {
      delays.push(ms);
      pending.set(++seq, { due: mono + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  async function advance(ms: number): Promise<void> {
    const end = mono + ms;
    for (;;) {
      const next = [...pending.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      pending.delete(next[0]);
      mono = Math.max(mono, next[1].due);
      next[1].fn();
      await flush();
    }
    mono = end;
    await flush();
  }
  return { timers, advance, flush, delays, pending, setNow: (t: string) => void (offset = at(t) - mono) };
}

function quiet() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, log: (m: string) => void logs.push(m), error: (m: string) => void errors.push(m) };
}

// ---------- échéances ----------

test('nextRun quotidien : même jour si l’heure est à venir, sinon lendemain ; strictement après', () => {
  const r = daily('04:30');
  assert.equal(iso(nextRun(r, at('2026-11-14T02:00:00Z'))), '2026-11-14T03:30:00.000Z');   // 03 h à Paris (UTC+1)
  assert.equal(iso(nextRun(r, at('2026-11-14T03:30:00Z'))), '2026-11-15T03:30:00.000Z');   // pile à l'échéance → lendemain
  assert.equal(iso(nextRun(r, at('2026-07-14T01:00:00Z'))), '2026-07-14T02:30:00.000Z');   // été (UTC+2)
  // Jour local différent du jour UTC : 23 h 30 UTC le 14 = 00 h 30 le 15 à Paris.
  assert.equal(iso(nextRun(r, at('2026-11-14T23:30:00Z'))), '2026-11-15T03:30:00.000Z');
  assert.equal(iso(nextRun(r, at('2026-12-31T23:59:00Z'))), '2027-01-01T03:30:00.000Z');
});

test('nextRun quotidien : dimanche du passage à l’heure d’été (29 mars 2026)', () => {
  const r = daily('04:30');
  const sat = nextRun(r, at('2026-03-28T00:00:00Z'));
  const sun = nextRun(r, sat);
  const mon = nextRun(r, sun);
  assert.equal(iso(sat), '2026-03-28T03:30:00.000Z');
  assert.equal(iso(sun), '2026-03-29T02:30:00.000Z');
  assert.equal(iso(mon), '2026-03-30T02:30:00.000Z');
  assert.equal(sun - sat, 23 * 3600_000);
  // 02:30 n'existe pas ce jour-là : décalé de la durée du saut (03:30 CEST = 01:30 UTC), une seule fois.
  const g = daily('02:30');
  const gap = nextRun(g, at('2026-03-28T12:00:00Z'));
  assert.equal(iso(gap), '2026-03-29T01:30:00.000Z');
  assert.equal(iso(nextRun(g, gap)), '2026-03-30T00:30:00.000Z');
  // Minuit existe toujours.
  assert.equal(iso(nextRun(daily('00:00'), at('2026-03-28T12:00:00Z'))), '2026-03-28T23:00:00.000Z');
});

test('nextRun quotidien : dimanche du passage à l’heure d’hiver (25 octobre 2026)', () => {
  const r = daily('04:30');
  const sat = nextRun(r, at('2026-10-24T00:00:00Z'));
  const sun = nextRun(r, sat);
  assert.equal(iso(sat), '2026-10-24T02:30:00.000Z');
  assert.equal(iso(sun), '2026-10-25T03:30:00.000Z');
  assert.equal(sun - sat, 25 * 3600_000);
  // 02:30 existe deux fois : la première (CEST), une seule exécution ce jour-là.
  const g = daily('02:30');
  const first = nextRun(g, at('2026-10-24T12:00:00Z'));
  assert.equal(iso(first), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(nextRun(g, first)), '2026-10-26T01:30:00.000Z');
  assert.equal(iso(nextRun(g, at('2026-10-25T01:00:00Z'))), '2026-10-26T01:30:00.000Z');
});

test('zonedToUtc : autre fuseau (New York, passage à l’heure d’été le 8 mars 2026)', () => {
  assert.equal(iso(zonedToUtc(Date.UTC(2026, 2, 8, 1, 30), 'America/New_York')), '2026-03-08T06:30:00.000Z');
  assert.equal(iso(zonedToUtc(Date.UTC(2026, 2, 8, 2, 30), 'America/New_York')), '2026-03-08T07:30:00.000Z'); // n'existe pas → 03:30 EDT
  assert.equal(iso(zonedToUtc(Date.UTC(2026, 2, 8, 3, 30), 'America/New_York')), '2026-03-08T07:30:00.000Z');
});

test('nextRun horaire : minute M de l’heure courante ou suivante, y compris les jours de changement d’heure', () => {
  const r = { every: 'hour' as const, minute: 5 };
  assert.equal(iso(nextRun(r, at('2026-11-14T10:00:00Z'))), '2026-11-14T10:05:00.000Z');
  assert.equal(iso(nextRun(r, at('2026-11-14T10:05:00Z'))), '2026-11-14T11:05:00.000Z');
  assert.equal(iso(nextRun(r, at('2026-11-14T23:59:59Z'))), '2026-11-15T00:05:00.000Z');
  // Dimanche du passage à l'heure d'hiver : 25 heures entre les deux minuits de Paris, donc 25 échéances.
  let t = at('2026-10-24T22:00:00Z');
  let n = 0;
  while ((t = nextRun(r, t)) < at('2026-10-25T23:00:00Z')) n++;
  assert.equal(n, 25);
});

// ---------- planificateur ----------

test('exécute la tâche quotidienne à l’échéance, puis chaque jour, en recevant un signal', async () => {
  const ft = fakeTimers('2026-11-14T03:00:00Z');
  const q = quiet();
  const s = createScheduler({ timers: ft.timers, ...q });
  const runs: string[] = [];
  s.daily('maintenance', '04:30', (signal) => {
    assert.ok(signal instanceof AbortSignal);
    runs.push(iso(ft.timers.now()));
  });
  await ft.advance(29 * 60_000);
  assert.deepEqual(runs, []);
  await ft.advance(60_000);
  assert.deepEqual(runs, ['2026-11-14T03:30:00.000Z']);
  await ft.advance(2 * 86_400_000);
  assert.deepEqual(runs, ['2026-11-14T03:30:00.000Z', '2026-11-15T03:30:00.000Z', '2026-11-16T03:30:00.000Z']);
  assert.deepEqual(q.errors, []);
  await s.stop();
});

test('aucun minuteur au-delà d’une heure, et l’échéance suit une correction de l’horloge', async () => {
  const ft = fakeTimers('2026-11-15T04:00:00Z');   // échéance : 16 novembre 03:30 UTC
  const s = createScheduler({ timers: ft.timers, ...quiet() });
  const runs: string[] = [];
  s.daily('maintenance', '04:30', () => void runs.push(iso(ft.timers.now())));
  assert.ok(ft.delays.every((d) => d <= 3600_000));
  // Horloge reculée d'un jour (ex. NTP au démarrage d'un Pi) : l'échéance est recalculée au réveil suivant.
  ft.setNow('2026-11-14T04:00:00Z');
  await ft.advance(24 * 3600_000);
  assert.deepEqual(runs, ['2026-11-15T03:30:00.000Z']);
  assert.ok(ft.delays.every((d) => d >= 0 && d <= 3600_000));
  await s.stop();
});

test('horloge avancée de plusieurs jours (NTP après fake-hwclock) : échéances manquées sautées, rien hors de son heure', async () => {
  const ft = fakeTimers('2026-11-10T22:00:00Z');
  const q = quiet();
  const s = createScheduler({ timers: ft.timers, ...q });
  const runs: string[] = [];
  s.daily('maintenance', '04:30', () => void runs.push(`m ${iso(ft.timers.now())}`));
  s.hourly('notifications', 5, () => void runs.push(`h ${iso(ft.timers.now())}`));
  ft.setNow('2026-11-14T14:20:00Z');
  await ft.advance(16 * 3600_000);   // jusqu'au 15 novembre 06:20 UTC
  assert.ok(runs.every((r) => r.endsWith(':05:00.000Z') || r === 'm 2026-11-15T03:30:00.000Z'), runs.join(', '));
  assert.deepEqual(runs.filter((r) => r.startsWith('m')), ['m 2026-11-15T03:30:00.000Z']);
  assert.equal(runs[0], 'h 2026-11-14T15:05:00.000Z');
  assert.equal(runs.filter((r) => r.startsWith('h')).length, 16);   // 15:05 → 06:05
  assert.equal(q.logs.filter((l) => /échéance manquée/.test(l)).length, 2);
  await s.stop();
});

test('réveil en retard de moins de LATE_MS : la tâche s’exécute quand même', async () => {
  const ft = fakeTimers('2026-11-14T10:00:00Z');
  const s = createScheduler({ timers: ft.timers, ...quiet() });
  const runs: string[] = [];
  s.hourly('notifications', 5, () => void runs.push(iso(ft.timers.now())));
  await ft.advance(4 * 60_000);
  ft.setNow('2026-11-14T10:05:30Z');   // l'horloge avance de 90 s juste avant l'échéance
  await ft.advance(60_000);
  assert.deepEqual(runs, ['2026-11-14T10:06:30.000Z']);
  await ft.advance(3600_000);
  assert.deepEqual(runs, ['2026-11-14T10:06:30.000Z', '2026-11-14T11:05:00.000Z']);
  await s.stop();
});

test('pas de chevauchement : une tâche encore en cours n’est pas relancée', async () => {
  const ft = fakeTimers('2026-11-14T10:00:00Z');
  const q = quiet();
  const s = createScheduler({ timers: ft.timers, ...q });
  let started = 0;
  let release!: () => void;
  s.hourly('notifications', 0, () => {
    started++;
    return new Promise<void>((resolve) => (release = resolve));
  });
  await ft.advance(3600_000);           // 11:00 : démarre
  await ft.advance(3600_000);           // 12:00 : encore en cours → sautée
  assert.equal(started, 1);
  assert.match(q.logs.join('\n'), /« notifications » encore en cours/);
  release();
  await ft.flush();
  await ft.advance(3600_000);           // 13:00 : relancée
  assert.equal(started, 2);
  release();
  await s.stop();
});

test('une erreur est journalisée et n’arrête ni la tâche ni les autres', async () => {
  const ft = fakeTimers('2026-11-14T10:00:00Z');
  const q = quiet();
  const s = createScheduler({ timers: ft.timers, ...q });
  let failing = 0;
  let ok = 0;
  s.hourly('casse', 0, async () => {
    failing++;
    throw new Error('boum');
  });
  s.hourly('sync', 30, () => {
    ok++;
    throw new TypeError('aussi synchrone');
  });
  s.hourly('saine', 15, () => void ok++);
  await ft.advance(3 * 3600_000);
  assert.equal(failing, 3);
  assert.equal(ok, 6);
  assert.equal(q.errors.filter((e) => e === 'tâche « casse » en échec : boum').length, 3);
  assert.equal(q.errors.filter((e) => e === 'tâche « sync » en échec : aussi synchrone').length, 3);
  await s.stop();
});

test('stop : plus aucun minuteur, signal abandonné, attend la fin de la tâche en cours', async () => {
  const ft = fakeTimers('2026-11-14T10:00:00Z');
  const s = createScheduler({ timers: ft.timers, ...quiet() });
  let signal: AbortSignal | undefined;
  let release!: () => void;
  let runs = 0;
  s.hourly('longue', 0, (sig) => {
    runs++;
    signal = sig;
    return new Promise<void>((resolve) => (release = resolve));
  });
  s.daily('maintenance', '04:30', () => void runs++);
  await ft.advance(3600_000);
  assert.equal(runs, 1);

  let stopped = false;
  const p = s.stop().then(() => void (stopped = true));
  assert.equal(signal?.aborted, true);
  assert.equal(ft.pending.size, 0);
  await ft.flush();
  assert.equal(stopped, false);
  release();
  await p;
  assert.equal(stopped, true);

  await ft.advance(3 * 86_400_000);
  assert.equal(runs, 1);
  assert.throws(() => s.hourly('après', 0, () => {}), /arrêté/);
});

test('paramètres invalides refusés à l’enregistrement', () => {
  const ft = fakeTimers('2026-11-14T10:00:00Z');
  const s = createScheduler({ timers: ft.timers, ...quiet() });
  assert.throws(() => s.daily('x', '4:30', () => {}), RangeError);
  assert.throws(() => s.daily('x', '24:00', () => {}), RangeError);
  assert.throws(() => s.daily('x', '04:30', () => {}, 'Europe/Nulle_Part'), RangeError);
  assert.throws(() => s.hourly('x', 60, () => {}), RangeError);
  assert.throws(() => s.hourly('x', 1.5, () => {}), RangeError);
  assert.equal(ft.pending.size, 0);
});
