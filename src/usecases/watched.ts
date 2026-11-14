import { transaction } from '../db/index.ts';
import { compareEpisodes, isAired } from '../domain/series.ts';
import { deleteWatched, getEpisodes, getSeasons, putWatched } from '../infra/repos.ts';
import { type Ctx, NotAiredError, NotFoundError, today } from './context.ts';
import { type ShowState, loadShow, showState, showStates } from './state.ts';

// Vu / non vu : idempotents, indépendants du suivi (marchent sur une série non suivie), sans effet sur la mise de côté manuelle.

// watchedAt fourni = date imposée, même si l'épisode est déjà vu (sert à « Annuler » une remise en non vu).
export type MarkEntry = { episodeId: number; watchedAt?: string };

export function markWatched(ctx: Ctx, entries: readonly MarkEntry[]): { marked: number[]; shows: ShowState[] } {
  const { marked, showIds } = applyMarks(ctx, entries);
  return { marked, shows: showStates(ctx, showIds) };
}

function applyMarks(ctx: Ctx, entries: readonly MarkEntry[]): { marked: number[]; showIds: number[] } {
  const { db, user } = ctx;
  const wanted = new Map(entries.map((e) => [e.episodeId, e.watchedAt]));
  const eps = getEpisodes(db, [...wanted.keys()]);
  if (eps.length !== wanted.size) throw new NotFoundError('épisode');
  const day = today(ctx);
  const notAired = eps.filter((e) => !isAired(e, day)).map((e) => e.id);
  if (notAired.length) throw new NotAiredError(notAired);

  // Sans date imposée : now + 1 ms par épisode dans l'ordre saison/numéro, pour que l'historique garde cet ordre.
  let tick = 0;
  const marked = transaction(db, () => eps.filter((e) => {
    const imposed = wanted.get(e.id);
    const at = imposed ?? new Date(ctx.now.getTime() + tick++).toISOString();
    return putWatched(db, user.id, e.id, at, imposed !== undefined);
  }).map((e) => e.id));
  return { marked, showIds: eps.map((e) => e.showId) };
}

// Renvoie les dates supprimées (pour « Annuler »). Un épisode déjà non vu est ignoré.
export function unmarkWatched(ctx: Ctx, episodeIds: readonly number[]): { removed: { episodeId: number; watchedAt: string }[]; shows: ShowState[] } {
  const { db, user } = ctx;
  const unique = [...new Set(episodeIds)];
  const eps = getEpisodes(db, unique);
  if (eps.length !== unique.length) throw new NotFoundError('épisode');
  const removed = transaction(db, () => eps.flatMap((e) => {
    const at = deleteWatched(db, user.id, e.id);
    return at === null ? [] : [{ episodeId: e.id, watchedAt: at }];
  }));
  return { removed, shows: showStates(ctx, eps.map((e) => e.showId)) };
}

// « Tout marquer vu jusqu'ici » : épisodes sortis non vus jusqu'à celui-ci inclus (ordre saison, numéro).
export function watchedUntil(ctx: Ctx, showId: number, episodeId: number): { marked: number[]; show: ShowState } {
  const s = loadShow(ctx, showId);
  const target = s.episodes.find((e) => e.id === episodeId);
  if (!target) throw new NotFoundError('épisode');
  const day = today(ctx);
  if (!isAired(target, day)) throw new NotAiredError([target.id]);
  const todo = s.episodes.filter((e) => compareEpisodes(e, target) <= 0 && isAired(e, day) && !s.input.watched.has(e.id));
  return markAndState(ctx, showId, todo.map((e) => e.id));
}

// Coche de saison : tous les épisodes sortis de la saison.
export function markSeason(ctx: Ctx, showId: number, season: number): { marked: number[]; show: ShowState } {
  const s = loadShow(ctx, showId);
  if (!getSeasons(ctx.db, showId).some((x) => x.number === season)) throw new NotFoundError('saison');
  const day = today(ctx);
  const eps = s.episodes.filter((e) => e.season === season);
  const aired = eps.filter((e) => isAired(e, day));
  if (!aired.length) throw new NotAiredError(eps.map((e) => e.id));
  return markAndState(ctx, showId, aired.filter((e) => !s.input.watched.has(e.id)).map((e) => e.id));
}

function markAndState(ctx: Ctx, showId: number, episodeIds: number[]): { marked: number[]; show: ShowState } {
  const marked = episodeIds.length ? applyMarks(ctx, episodeIds.map((episodeId) => ({ episodeId }))).marked : [];
  return { marked, show: showState(ctx, loadShow(ctx, showId)) };
}
