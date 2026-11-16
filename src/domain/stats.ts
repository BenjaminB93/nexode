// Statistiques de visionnage d'un utilisateur. Pur, sans I/O.
// Périmètre : séries suivies ou de côté (« Mes séries ») ; une série qu'on ne suit plus n'entre dans aucun chiffre.
// Les stats datées (mois, binge, saison dévorée, dès la sortie, fidélité) ne comptent que les visionnages marqués seuls :
// l'heure d'un marquage en lot ou d'un import sans provenance ne date pas un visionnage (voir migration 005).
import { daysBetween, localDate } from './dates.ts';
import type { ShowStatus } from './series.ts';

export type StatWatch = {
  episodeId: number; showId: number; season: number;
  airDate: string | null; runtime: number | null;   // runtime en minutes, null = inconnu (non compté)
  watchedAt: string; single: boolean;
};
export type StatShow = {
  id: number;
  relation: 'on' | 'shelf';
  status: ShowStatus;
  seen: number; remaining: number;                   // épisodes vus ; sortis non vus
  airedBySeason: ReadonlyMap<number, readonly number[]>;   // ids des épisodes sortis, par saison
};

export type Stats = {
  episodes: number; minutes: number; started: number; finished: number;
  months: { month: string; episodes: number }[];     // 12 derniers mois, le plus ancien d'abord
  binge: { showId: number; episodes: number; night: string } | null;
  fastestSeason: { showId: number; season: number; episodes: number; days: number } | null;
  closestEnd: { showId: number; remaining: number } | null;
  sameDay: number | null;                            // null : aucun visionnage marqué seul
  catchUp: { showId: number; episodes: number; night: string } | null;
  loyalty: { showId: number; since: string } | null;
};

export const BINGE_MIN = 3;          // en dessous, ce n'est pas un binge
export const SEASON_MIN = 4;         // saison dévorée : au moins 4 épisodes
export const CATCH_UP_MIN = 2;       // rattrapage : au moins 2 épisodes marqués d'un coup
const NIGHT_SHIFT_MS = 5 * 3600_000; // une nuit va jusqu'à 5 h : une soirée n'est pas coupée à minuit
const SAME_DAY_MAX = 1;              // « dès la sortie » : le jour même ou le lendemain (date TMDB = pays d'origine, souvent les États-Unis)

// Jour auquel rattacher un visionnage : la veille avant 5 h du matin.
export const nightOf = (at: string, timezone: string): string => localDate(new Date(Date.parse(at) - NIGHT_SHIFT_MS), timezone);

export function computeStats(watchesIn: readonly StatWatch[], shows: readonly StatShow[], opts: { timezone: string; today: string }): Stats {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const watches = watchesIn.filter((w) => byId.has(w.showId));
  const singles = watches.filter((w) => w.single);
  const tz = opts.timezone;

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

  return {
    episodes: watches.length,
    minutes: watches.reduce((n, w) => n + (w.runtime ?? 0), 0),
    started: shows.filter((s) => s.seen > 0).length,
    finished: shows.filter((s) => s.seen > 0 && s.status === 'terminee').length,
    months: months(singles, opts),
    binge: biggest(singles, BINGE_MIN),
    fastestSeason: fastestSeason(singles, shows, tz),
    closestEnd: closestEnd(shows),
    sameDay: singles.length ? singles.filter((w) => sameDay(w, tz)).length : null,
    catchUp: biggest(watches.filter((w) => !w.single), CATCH_UP_MIN),
    loyalty: loyalty(singles, byId),
  };
}

function months(singles: readonly StatWatch[], { timezone, today }: { timezone: string; today: string }) {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const list: { month: string; episodes: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    list.push({ month: d.toISOString().slice(0, 7), episodes: 0 });
  }
  const index = new Map(list.map((x, i) => [x.month, i]));
  for (const w of singles) {
    const i = index.get(localDate(w.watchedAt, timezone).slice(0, 7));
    if (i !== undefined) (list[i] as { episodes: number }).episodes++;
  }
  return list;
}

// Saison dont tous les épisodes sortis ont été marqués seuls, vue sur le moins de nuits ; à égalité, la plus longue, puis la plus récente.
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

function sameDay(w: StatWatch, tz: string): boolean {
  if (w.airDate === null) return false;
  const gap = daysBetween(w.airDate, localDate(w.watchedAt, tz));
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
