import { localDate } from '../domain/dates.ts';
import { isAired } from '../domain/series.ts';
import { type StatRange, type StatShow, computeStats, periodOf } from '../domain/stats.ts';
import { getStatWatches, getUserShows } from '../infra/repos.ts';
import { type Ctx, today } from './context.ts';
import { type ShowRef, loadShows, showRef } from './state.ts';

// Page « Mes statistiques » : chiffres calculés à la demande (quelques milliers de lignes), séries référencées par ShowRef.
// unfollowed : compter aussi les séries qu'on ne suit plus (absentes de « Mes séries ») dont des épisodes ont été vus.
// years : années où au moins un épisode a été vu (toutes séries), la plus récente d'abord, pour le choix de la période.
export function stats(ctx: Ctx, opts: { range: StatRange; unfollowed: boolean }) {
  const { db, user } = ctx;
  const day = today(ctx);
  const watches = getStatWatches(db, user.id).map((w) => ({ ...w, single: w.single === 1 }));
  const followed = getUserShows(db, user.id).map((f) => f.showId);
  const scope = opts.unfollowed ? [...new Set([...followed, ...watches.map((w) => w.showId)])] : followed;
  const loaded = loadShows(ctx, scope);
  const shows: StatShow[] = [...loaded.values()].map((s) => {
    const airedBySeason = new Map<number, number[]>();
    for (const e of s.episodes) {
      if (!isAired(e, day)) continue;
      const list = airedBySeason.get(e.season);
      if (list) list.push(e.id);
      else airedBySeason.set(e.season, [e.id]);
    }
    return { id: s.show.id, relation: s.relation, status: s.info.status, seen: s.info.seen, remaining: s.info.remaining, airedBySeason };
  });

  const days = watches.map((w) => localDate(w.watchedAt, user.timezone));
  const years = [...new Set(days.map((d) => Number(d.slice(0, 4))))].sort((a, b) => b - a);
  const inScope = new Set(loaded.keys());
  const firstDay = days.filter((_, i) => inScope.has((watches[i] as { showId: number }).showId)).sort()[0] ?? null;
  const r = computeStats(watches, shows, { timezone: user.timezone, period: periodOf(opts.range, day, firstDay) });

  const ref = (id: number): ShowRef => showRef((loaded.get(id) as NonNullable<ReturnType<typeof loaded.get>>).show);
  const withShow = <T extends { showId: number }>(x: T | null) => {
    if (!x) return null;
    const { showId, ...rest } = x;
    return { show: ref(showId), ...rest };
  };
  return {
    range: opts.range, unfollowed: opts.unfollowed, years,
    episodes: r.episodes, minutes: r.minutes, started: r.started, finished: r.finished, histogram: r.histogram,
    binge: withShow(r.binge), fastestSeason: withShow(r.fastestSeason), closestEnd: withShow(r.closestEnd),
    sameDay: r.sameDay, catchUp: withShow(r.catchUp), loyalty: withShow(r.loyalty),
  };
}
