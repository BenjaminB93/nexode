import {
  type EpisodeRow, type ShowRow,
  getEpisodesOfShows, getShow, getShows, getUserShowsFor, getWatchedForShows,
} from '../infra/repos.ts';
import {
  type Follow, type Relation, type ShowStatus, type StatusInput, type StatusResult,
  computeStatus, relationOf, wouldBeStatus,
} from '../domain/series.ts';
import { type Ctx, AppError, NotFoundError, UpstreamError, nowIso, today } from './context.ts';

// Une série chargée pour l'utilisateur courant, avec son état calculé.
export type LoadedShow = {
  show: ShowRow;
  episodes: EpisodeRow[];
  follow: Follow | null;
  input: StatusInput<EpisodeRow>;
  info: StatusResult<EpisodeRow>;
  relation: Relation;
};

// Charge plusieurs séries en 4 requêtes (séries, épisodes, vus, suivi). Les ids absents du cache sont ignorés.
export function loadShows(ctx: Ctx, showIds: readonly number[]): Map<number, LoadedShow> {
  const { db, user } = ctx;
  const out = new Map<number, LoadedShow>();
  if (!showIds.length) return out;
  const shows = getShows(db, showIds);
  const episodes = getEpisodesOfShows(db, showIds);
  const watched = getWatchedForShows(db, user.id, showIds);
  const follows = new Map(getUserShowsFor(db, user.id, showIds).map((f) => [f.showId, f]));
  const byShow = new Map<number, EpisodeRow[]>();
  for (const e of episodes) {
    const list = byShow.get(e.showId);
    if (list) list.push(e);
    else byShow.set(e.showId, [e]);
  }
  const day = today(ctx);
  for (const show of shows) {
    const f = follows.get(show.id);
    const follow: Follow | null = f ? { state: f.state, addedAt: f.addedAt, resumedAt: f.resumedAt } : null;
    const input: StatusInput<EpisodeRow> = {
      episodes: byShow.get(show.id) ?? [],
      watched,
      showStatus: show.status,
      follow,
      today: day,
      timezone: user.timezone,
      shelveAfterDays: user.shelveAfterDays,
    };
    const info = computeStatus(input);
    out.set(show.id, { show, episodes: [...input.episodes], follow, input, info, relation: relationOf(follow, info.status) });
  }
  return out;
}

export function loadShow(ctx: Ctx, showId: number): LoadedShow {
  const s = loadShows(ctx, [showId]).get(showId);
  if (!s) throw new NotFoundError('série');
  return s;
}

// Garantit la série en cache. Si TMDB est injoignable mais que la série est déjà en cache, on sert le cache.
export async function ensureShowCached(ctx: Ctx, showId: number): Promise<ShowRow> {
  try {
    await ctx.catalog.ensureShow(showId);
  } catch (err) {
    const cached = getShow(ctx.db, showId);
    if (cached) {
      console.warn(`catalogue : série ${showId} servie depuis le cache (${(err as Error).message})`);
      return cached;
    }
    if (err instanceof AppError) throw err;
    // Le contrat Catalog ne type pas « série inconnue » : une erreur portant status 404 (réponse TMDB) en tient lieu.
    if ((err as { status?: unknown }).status === 404) throw new NotFoundError('série');
    throw new UpstreamError(`catalogue indisponible pour la série ${showId} : ${(err as Error).message}`);
  }
  const show = getShow(ctx.db, showId);
  if (!show) throw new NotFoundError('série');
  return show;
}

// ---------- formes renvoyées par l'API ----------

export type EpisodeView = { id: number; season: number; number: number; title: string | null; titleIsVo: boolean; airDate: string | null };
export const episodeView = (e: EpisodeRow): EpisodeView =>
  ({ id: e.id, season: e.season, number: e.number, title: e.title, titleIsVo: e.titleIsVo === 1, airDate: e.airDate });

export type ShowRef = { id: number; name: string; posterPath: string | null };
export const showRef = (s: ShowRow): ShowRef => ({ id: s.id, name: s.name, posterPath: s.posterPath });

// État d'une série renvoyé après chaque écriture, pour que le client se recale.
// status est null pour une série non suivie : seuls relation et wouldBeStatus s'affichent alors.
export type ShowState = {
  id: number; relation: Relation; status: ShowStatus | null; wouldBeStatus: ShowStatus;
  next: EpisodeView | null; remaining: number; seen: number; total: number;
};
export function showState(ctx: Ctx, s: LoadedShow): ShowState {
  return {
    id: s.show.id,
    relation: s.relation,
    status: followedStatus(s),
    wouldBeStatus: wouldBeStatus(s.input, nowIso(ctx)),
    next: s.info.next ? episodeView(s.info.next) : null,
    remaining: s.info.remaining,
    seen: s.info.seen,
    total: s.info.total,
  };
}

export function showStates(ctx: Ctx, showIds: readonly number[]): ShowState[] {
  const loaded = loadShows(ctx, [...new Set(showIds)]);
  return [...loaded.values()].map((s) => showState(ctx, s));
}

// Ligne de série commune à « Mes séries » et aux résultats de recherche.
export function seriesRow(s: LoadedShow, seasonCount: number) {
  return {
    id: s.show.id,
    name: s.show.name,
    posterPath: s.show.posterPath,
    year: yearOf(s.show.firstAirDate),
    seasonCount,
    statusLabel: statusLabel(s.show.status),
    seen: s.info.seen,
    total: s.info.total,
    relation: s.relation,
    status: followedStatus(s),
  };
}

const followedStatus = (s: LoadedShow): ShowStatus | null => (s.relation === 'none' ? null : s.info.status);

// Libellé du sous-titre « année · N saisons · statut ».
export function statusLabel(status: string): string | null {
  switch (status) {
    case 'returning': return 'en diffusion';
    case 'ended': return 'terminée';
    case 'canceled': return 'annulée';
    case 'in_production': return 'en production';
    case 'planned': return 'annoncée';
    case 'pilot': return 'pilote';
    default: return null;
  }
}

export const yearOf = (date: string | null) => (date ? Number(date.slice(0, 4)) : null);
