import { localDate } from '../domain/dates.ts';
import { type ProviderItem, type SeasonProviders, providerGroups, withShowFallback } from '../domain/providers.ts';
import { isAired } from '../domain/series.ts';
import { type ProviderRow, getProviders, getSeasonEpisodes, getSeasons } from '../infra/repos.ts';
import { type Ctx, NotFoundError, today } from './context.ts';
import { ensureShowCached, loadShow, showState, statusLabel, yearOf } from './state.ts';

// Plateformes : en cas d'échec TMDB, on sert ce qui est en cache (éventuellement rien).
async function ensureProvidersCached(ctx: Ctx, showId: number): Promise<void> {
  try {
    await ctx.catalog.ensureProviders(showId, ctx.user.country);
  } catch (err) {
    console.warn(`catalogue : plateformes de la série ${showId} non rafraîchies (${(err as Error).message})`);
  }
}

const providerItem = (p: ProviderRow): ProviderItem => ({ id: p.id, name: p.name, logoPath: p.logoPath });

// Fiche série : méta, relation, saisons (vus / sortis / total), plateformes du pays de l'utilisateur.
// Plateformes par saison, avec repli sur le relevé de la série (saison 0) quand aucune saison n'est renseignée.
function seasonProviders(rows: readonly ProviderRow[], numbers: readonly number[]): SeasonProviders[] {
  const of = (season: number) => rows.filter((p) => p.season === season).map(providerItem);
  return withShowFallback(numbers.map((n) => ({ season: n, items: of(n) })), of(0));
}

export async function showDetail(ctx: Ctx, showId: number) {
  await ensureShowCached(ctx, showId);
  await ensureProvidersCached(ctx, showId);
  const s = loadShow(ctx, showId);
  const seasons = getSeasons(ctx.db, showId);
  const providers = getProviders(ctx.db, showId, ctx.user.country);
  const day = today(ctx);
  return {
    ...showState(ctx, s),
    name: s.show.name,
    originalName: s.show.originalName,
    overview: s.show.overview,
    posterPath: s.show.posterPath,
    year: yearOf(s.show.firstAirDate),
    statusLabel: statusLabel(s.show.status),
    seasonCount: seasons.length,
    seasons: seasons.map((se) => {
      const eps = s.episodes.filter((e) => e.season === se.number);
      return {
        number: se.number,
        name: se.name,
        posterPath: se.posterPath,
        firstAirDate: eps[0]?.airDate ?? se.airDate,
        count: eps.length,
        aired: eps.filter((e) => isAired(e, day)).length,
        seen: eps.filter((e) => s.input.watched.has(e.id)).length,
      };
    }),
    providers: {
      country: ctx.user.country,
      groups: providerGroups(seasonProviders(providers, seasons.map((se) => se.number))),
    },
  };
}

// Vue saison : épisodes avec état vu, plus de quoi afficher la fiche épisode sans autre appel.
export async function seasonDetail(ctx: Ctx, showId: number, number: number) {
  await ensureShowCached(ctx, showId);
  await ensureProvidersCached(ctx, showId);
  const s = loadShow(ctx, showId);
  const se = getSeasons(ctx.db, showId).find((x) => x.number === number);
  if (!se) throw new NotFoundError('saison');
  const day = today(ctx);
  const watched = s.input.watched;

  // untilCount : épisodes sortis non vus jusqu'à celui-ci inclus, toutes saisons (« Tout marquer vu jusqu'ici (n) »).
  const untilCount = new Map<number, number>();
  let pending = 0;
  for (const e of s.episodes) {
    if (isAired(e, day) && !watched.has(e.id)) pending++;
    untilCount.set(e.id, pending);
  }

  const eps = getSeasonEpisodes(ctx.db, showId, number);
  return {
    show: { id: s.show.id, name: s.show.name, relation: s.relation },
    season: {
      number: se.number,
      name: se.name,
      overview: se.overview,
      airDate: se.airDate,
      posterPath: se.posterPath,
      count: eps.length,
      aired: eps.filter((e) => isAired(e, day)).length,
      seen: eps.filter((e) => watched.has(e.id)).length,
    },
    providers: seasonProviders(getProviders(ctx.db, showId, ctx.user.country), getSeasons(ctx.db, showId).map((se) => se.number))
      .find((s) => s.season === number)?.items ?? [],
    episodes: eps.map((e) => {
      const at = watched.get(e.id) ?? null;
      return {
        id: e.id,
        season: e.season,
        number: e.number,
        title: e.title,
        titleIsVo: e.titleIsVo === 1,
        overview: e.overview,
        airDate: e.airDate,
        runtime: e.runtime,
        stillPath: e.stillPath,
        aired: isAired(e, day),
        watchedAt: at,
        watchedDay: at === null ? null : localDate(at, ctx.user.timezone),
        untilCount: untilCount.get(e.id) ?? 0,
      };
    }),
  };
}
