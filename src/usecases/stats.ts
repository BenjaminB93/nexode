import { isAired } from '../domain/series.ts';
import { type StatShow, computeStats } from '../domain/stats.ts';
import { getStatWatches, getUserShows } from '../infra/repos.ts';
import { type Ctx, today } from './context.ts';
import { type ShowRef, loadShows, showRef } from './state.ts';

// Page « Mes statistiques » : chiffres calculés à la demande (quelques milliers de lignes), séries référencées par ShowRef.
export function stats(ctx: Ctx) {
  const { db, user } = ctx;
  const day = today(ctx);
  const loaded = loadShows(ctx, getUserShows(db, user.id).map((f) => f.showId));
  const shows: StatShow[] = [...loaded.values()].map((s) => {
    const airedBySeason = new Map<number, number[]>();
    for (const e of s.episodes) {
      if (!isAired(e, day)) continue;
      const list = airedBySeason.get(e.season);
      if (list) list.push(e.id);
      else airedBySeason.set(e.season, [e.id]);
    }
    return { id: s.show.id, relation: s.relation === 'shelf' ? 'shelf' : 'on', status: s.info.status, seen: s.info.seen, remaining: s.info.remaining, airedBySeason };
  });
  const watches = getStatWatches(db, user.id).map((w) => ({ ...w, single: w.single === 1 }));
  const r = computeStats(watches, shows, { timezone: user.timezone, today: day });
  const ref = (id: number): ShowRef => showRef((loaded.get(id) as NonNullable<ReturnType<typeof loaded.get>>).show);
  const withShow = <T extends { showId: number }>(x: T | null) => {
    if (!x) return null;
    const { showId, ...rest } = x;
    return { show: ref(showId), ...rest };
  };
  return {
    episodes: r.episodes, minutes: r.minutes, started: r.started, finished: r.finished, months: r.months,
    binge: withShow(r.binge), fastestSeason: withShow(r.fastestSeason), closestEnd: withShow(r.closestEnd),
    sameDay: r.sameDay, catchUp: withShow(r.catchUp), loyalty: withShow(r.loyalty),
  };
}
