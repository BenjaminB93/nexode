// Statistiques de visionnage d'un utilisateur. Pur, sans I/O.
// Périmètre : les séries passées dans `shows` (l'appelant choisit d'y mettre ou non les séries qu'on ne suit plus).
// Période : les chiffres tirés des visionnages ne comptent que ceux de la période (jour local) ; « abandon le plus rageant »
// et « fidélité » décrivent l'état actuel et l'ignorent.
// Les stats datées (histogramme, binge, saison dévorée, dès la sortie, fidélité) ne comptent que les visionnages marqués seuls :
// l'heure d'un marquage en lot ou d'un import sans provenance ne date pas un visionnage (voir migration 005).
import { daysBetween, localDate } from './dates.ts';
import type { Relation, ShowStatus } from './series.ts';

export type StatWatch = {
  episodeId: number; showId: number; season: number;
  airDate: string | null; runtime: number | null;   // runtime en minutes, null = inconnu (non compté)
  watchedAt: string; single: boolean;
};
export type StatShow = {
  id: number;
  relation: Relation;
  status: ShowStatus;
  seen: number; remaining: number;                   // épisodes vus ; sortis non vus
  airedBySeason: ReadonlyMap<number, readonly number[]>;   // ids des épisodes sortis, par saison
};

// Période choisie : tout, une année ('2024'), ou les derniers 1 an / 6 mois / 3 mois / 1 mois.
export type StatRange = 'all' | '1y' | '6m' | '3m' | '1m' | string;
export const RANGES: readonly string[] = ['all', '1y', '6m', '3m', '1m'];
export const isRange = (r: string): boolean => RANGES.includes(r) || /^(19|20)\d\d$/.test(r);

// Unité de l'histogramme et clés de ses barres : 'YYYY', 'YYYY-MM', lundi 'YYYY-MM-DD' de la semaine, ou jour 'YYYY-MM-DD'.
export type Unit = 'year' | 'month' | 'week' | 'day';
export type Period = { from: string | null; to: string; unit: Unit; keys: string[] };

export type Stats = {
  episodes: number; minutes: number; started: number; finished: number;
  histogram: { unit: Unit; buckets: { key: string; episodes: number }[] };
  binge: { showId: number; episodes: number; night: string } | null;
  fastestSeason: { showId: number; season: number; episodes: number; days: number } | null;
  closestEnd: { showId: number; remaining: number } | null;
  sameDay: number | null;                            // null : aucun visionnage marqué seul dans la période
  catchUp: { showId: number; episodes: number; night: string } | null;
  loyalty: { showId: number; since: string } | null;
};

export const BINGE_MIN = 3;          // en dessous, ce n'est pas un binge
export const SEASON_MIN = 4;         // saison dévorée : au moins 4 épisodes
export const CATCH_UP_MIN = 2;       // rattrapage : au moins 2 épisodes marqués d'un coup
const NIGHT_SHIFT_MS = 5 * 3600_000; // une nuit va jusqu'à 5 h : une soirée n'est pas coupée à minuit
const SAME_DAY_MAX = 1;              // « dès la sortie » : le jour même ou le lendemain (date TMDB = pays d'origine, souvent les États-Unis)
const DAY_MS = 86_400_000;

// Jour auquel rattacher un visionnage : la veille avant 5 h du matin.
export const nightOf = (at: string, timezone: string): string => localDate(new Date(Date.parse(at) - NIGHT_SHIFT_MS), timezone);

const utcMs = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(utcMs(day) + n * DAY_MS);
const mondayOf = (day: string) => addDays(day, -((new Date(utcMs(day)).getUTCDay() + 6) % 7));
const monthKey = (y: number, m0: number) => new Date(Date.UTC(y, m0, 1)).toISOString().slice(0, 7);

export function bucketOf(day: string, unit: Unit): string {
  if (unit === 'year') return day.slice(0, 4);
  if (unit === 'month') return day.slice(0, 7);
  return unit === 'week' ? mondayOf(day) : day;
}

// Bornes et barres d'une période. 1 an / 6 mois : mois calendaires, celui en cours compris ; 3 mois : 13 semaines (lundi) ;
// 1 mois : 30 jours. Tout : une barre par année, depuis la première année vue.
export function periodOf(range: StatRange, today: string, firstDay: string | null): Period {
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  const months = (n: number): Period => {
    const keys = Array.from({ length: n }, (_, i) => monthKey(y, m0 - (n - 1) + i));
    return { from: `${keys[0]}-01`, to: today, unit: 'month', keys };
  };
  if (range === '1y') return months(12);
  if (range === '6m') return months(6);
  if (range === '3m') {
    const first = addDays(mondayOf(today), -12 * 7);
    return { from: first, to: today, unit: 'week', keys: Array.from({ length: 13 }, (_, i) => addDays(first, i * 7)) };
  }
  if (range === '1m') {
    const first = addDays(today, -29);
    return { from: first, to: today, unit: 'day', keys: Array.from({ length: 30 }, (_, i) => addDays(first, i)) };
  }
  if (/^\d{4}$/.test(range)) {
    const year = Number(range);
    return { from: `${range}-01-01`, to: `${range}-12-31`, unit: 'month', keys: Array.from({ length: 12 }, (_, i) => monthKey(year, i)) };
  }
  const y0 = Math.min(y, firstDay ? Number(firstDay.slice(0, 4)) : y);
  return { from: null, to: today, unit: 'year', keys: Array.from({ length: y - y0 + 1 }, (_, i) => String(y0 + i)) };
}

export function computeStats(watchesIn: readonly StatWatch[], shows: readonly StatShow[], opts: { timezone: string; period: Period }): Stats {
  const { timezone: tz, period } = opts;
  const byId = new Map(shows.map((s) => [s.id, s]));
  const scoped = watchesIn.filter((w) => byId.has(w.showId));
  const dayOfWatch = new Map(scoped.map((w) => [w, localDate(w.watchedAt, tz)]));
  const inPeriod = (day: string) => (period.from === null || day >= period.from) && day <= period.to;
  const watches = scoped.filter((w) => inPeriod(dayOfWatch.get(w) as string));
  const singles = watches.filter((w) => w.single);

  // Premier et dernier jour de visionnage de chaque série (toutes périodes) : commencée / terminée dans la période.
  const span = new Map<number, { first: string; last: string }>();
  for (const w of scoped) {
    const d = dayOfWatch.get(w) as string;
    const s = span.get(w.showId);
    if (!s) span.set(w.showId, { first: d, last: d });
    else { if (d < s.first) s.first = d; if (d > s.last) s.last = d; }
  }

  // Plus grand groupe (série, nuit) ; à égalité, le plus récent.
  const biggest = (list: readonly StatWatch[], min: number) => {
    const groups = new Map<string, { showId: number; night: string; episodes: number }>();
    for (const w of list) {
      const night = nightOf(w.watchedAt, tz);
      const k = `${w.showId} ${night}`;
      const g = groups.get(k);
      if (g) g.episodes++;
      else groups.set(k, { showId: w.showId, night, episodes: 1 });
    }
    let best: { showId: number; night: string; episodes: number } | null = null;
    for (const g of groups.values()) {
      if (!best || g.episodes > best.episodes || (g.episodes === best.episodes && g.night > best.night)) best = g;
    }
    return best && best.episodes >= min ? best : null;
  };

  const counts = new Map(period.keys.map((k) => [k, 0]));
  for (const w of singles) {
    const k = bucketOf(dayOfWatch.get(w) as string, period.unit);
    const n = counts.get(k);
    if (n !== undefined) counts.set(k, n + 1);
  }

  return {
    episodes: watches.length,
    minutes: watches.reduce((n, w) => n + (w.runtime ?? 0), 0),
    started: shows.filter((s) => { const x = span.get(s.id); return !!x && inPeriod(x.first); }).length,
    finished: shows.filter((s) => { const x = span.get(s.id); return !!x && s.status === 'terminee' && inPeriod(x.last); }).length,
    histogram: { unit: period.unit, buckets: period.keys.map((key) => ({ key, episodes: counts.get(key) as number })) },
    binge: biggest(singles, BINGE_MIN),
    fastestSeason: fastestSeason(singles, shows, tz),
    closestEnd: closestEnd(shows),
    sameDay: singles.length ? singles.filter((w) => sameDay(w, dayOfWatch.get(w) as string)).length : null,
    catchUp: biggest(watches.filter((w) => !w.single), CATCH_UP_MIN),
    loyalty: loyalty(scoped.filter((w) => w.single), byId),
  };
}

// Saison dont tous les épisodes sortis ont été marqués seuls (dans la période), vue sur le moins de nuits ;
// à égalité, la plus longue, puis la plus récente.
function fastestSeason(singles: readonly StatWatch[], shows: readonly StatShow[], tz: string): Stats['fastestSeason'] {
  const at = new Map(singles.map((w) => [w.episodeId, w.watchedAt]));
  let best: (NonNullable<Stats['fastestSeason']> & { last: string }) | null = null;
  for (const s of shows) {
    for (const [season, ids] of s.airedBySeason) {
      if (ids.length < SEASON_MIN || !ids.every((id) => at.has(id))) continue;
      const nights = ids.map((id) => nightOf(at.get(id) as string, tz)).sort();
      const first = nights[0] as string;
      const last = nights.at(-1) as string;
      const c = { showId: s.id, season, episodes: ids.length, days: daysBetween(first, last) + 1, last };
      if (!best || c.days < best.days || (c.days === best.days && (c.episodes > best.episodes || (c.episodes === best.episodes && c.last > best.last)))) best = c;
    }
  }
  if (!best) return null;
  const { last: _last, ...out } = best;
  return out;
}

// Série de côté commencée qu'il reste le moins d'épisodes sortis pour finir ; à égalité, la plus avancée.
function closestEnd(shows: readonly StatShow[]): Stats['closestEnd'] {
  const list = shows.filter((s) => s.relation === 'shelf' && s.seen > 0 && s.remaining > 0)
    .sort((a, b) => a.remaining - b.remaining || b.seen - a.seen);
  const s = list[0];
  return s ? { showId: s.id, remaining: s.remaining } : null;
}

function sameDay(w: StatWatch, watchedDay: string): boolean {
  if (w.airDate === null) return false;
  const gap = daysBetween(w.airDate, watchedDay);
  return gap >= 0 && gap <= SAME_DAY_MAX;
}

// Série en cours (pas de côté) regardée depuis le plus longtemps : premier visionnage marqué seul le plus ancien.
function loyalty(watches: readonly StatWatch[], byId: ReadonlyMap<number, StatShow>): Stats['loyalty'] {
  let best: StatWatch | null = null;
  for (const w of watches) {
    if (byId.get(w.showId)?.relation !== 'on') continue;
    if (!best || w.watchedAt < best.watchedAt) best = w;
  }
  return best ? { showId: best.showId, since: best.watchedAt } : null;
}
