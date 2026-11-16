import { transaction } from '../db/index.ts';
import { localDate } from '../domain/dates.ts';
import { compareEpisodes, isAired } from '../domain/series.ts';
import {
  deleteWatched, getEpisodes, getSeasons, purgeUnwatchedRecent, putUnwatchedRecent, putWatched, takeUnwatchedRecent,
} from '../infra/repos.ts';
import { type Ctx, NotAiredError, NotFoundError, today } from './context.ts';
import { type ShowState, loadShow, showState, showStates } from './state.ts';

// Vu / non vu : idempotents, indépendants du suivi (marchent sur une série non suivie), sans effet sur la mise de côté manuelle.

// watchedAt fourni = date imposée, même si l'épisode est déjà vu (sert à « Annuler » une remise en non vu) ;
// single l'accompagne pour rendre aussi la provenance. Sans single : une action qui marque un seul épisode le marque « seul ».
export type MarkEntry = { episodeId: number; watchedAt?: string; single?: boolean };

// Recocher moins de 5 min après avoir décoché rend le visionnage d'origine (date, provenance) : plus court que tout épisode,
// un recochage aussi rapide corrige forcément une erreur de manipulation.
export const RECHECK_WINDOW_MS = 5 * 60_000;
// Visionnages rendus tels qu'avant : le client les replace dans l'historique.
export type Restored = { episodeId: number; watchedAt: string; watchedDay: string };

export function markWatched(ctx: Ctx, entries: readonly MarkEntry[]): { marked: number[]; restored: Restored[]; shows: ShowState[] } {
  const { marked, restored, showIds } = applyMarks(ctx, entries);
  return { marked, restored, shows: showStates(ctx, showIds) };
}

const windowStart = (ctx: Ctx) => new Date(ctx.now.getTime() - RECHECK_WINDOW_MS).toISOString();

function applyMarks(ctx: Ctx, entries: readonly MarkEntry[]): { marked: number[]; restored: Restored[]; showIds: number[] } {
  const { db, user } = ctx;
  const wanted = new Map(entries.map((e) => [e.episodeId, e.watchedAt]));
  const eps = getEpisodes(db, [...wanted.keys()]);
  if (eps.length !== wanted.size) throw new NotFoundError('épisode');
  const day = today(ctx);
  const notAired = eps.filter((e) => !isAired(e, day)).map((e) => e.id);
  if (notAired.length) throw new NotAiredError(notAired);

  // Sans date imposée : now + 1 ms par épisode dans l'ordre saison/numéro, pour que l'historique garde cet ordre.
  const singles = new Map(entries.map((e) => [e.episodeId, e.single ?? eps.length === 1]));
  let tick = 0;
  const restored: Restored[] = [];
  const marked = transaction(db, () => {
    purgeUnwatchedRecent(db, user.id, windowStart(ctx));
    return eps.filter((e) => {
      const imposed = wanted.get(e.id);
      const back = takeUnwatchedRecent(db, user.id, e.id);
      if (imposed !== undefined) return putWatched(db, user.id, e.id, imposed, singles.get(e.id) as boolean, true);
      if (back) {
        const ok = putWatched(db, user.id, e.id, back.watchedAt, back.single, false);
        if (ok) restored.push({ episodeId: e.id, watchedAt: back.watchedAt, watchedDay: localDate(back.watchedAt, user.timezone) });
        return ok;
      }
      return putWatched(db, user.id, e.id, new Date(ctx.now.getTime() + tick++).toISOString(), singles.get(e.id) as boolean, false);
    }).map((e) => e.id);
  });
  return { marked, restored, showIds: eps.map((e) => e.showId) };
}

// Renvoie les dates et provenances supprimées (pour « Annuler »). Un épisode déjà non vu est ignoré.
export function unmarkWatched(ctx: Ctx, episodeIds: readonly number[]): { removed: { episodeId: number; watchedAt: string; single: boolean }[]; shows: ShowState[] } {
  const { db, user } = ctx;
  const unique = [...new Set(episodeIds)];
  const eps = getEpisodes(db, unique);
  if (eps.length !== unique.length) throw new NotFoundError('épisode');
  const removedAt = ctx.now.toISOString();
  const removed = transaction(db, () => {
    purgeUnwatchedRecent(db, user.id, windowStart(ctx));
    return eps.flatMap((e) => {
      const r = deleteWatched(db, user.id, e.id);
      if (r === null) return [];
      putUnwatchedRecent(db, user.id, e.id, r.watchedAt, r.single, removedAt);
      return [{ episodeId: e.id, ...r }];
    });
  });
  return { removed, shows: showStates(ctx, eps.map((e) => e.showId)) };
}

// « Tout marquer vu jusqu'ici » : épisodes sortis non vus jusqu'à celui-ci inclus (ordre saison, numéro).
export function watchedUntil(ctx: Ctx, showId: number, episodeId: number): { marked: number[]; restored: Restored[]; show: ShowState } {
  const s = loadShow(ctx, showId);
  const target = s.episodes.find((e) => e.id === episodeId);
  if (!target) throw new NotFoundError('épisode');
  const day = today(ctx);
  if (!isAired(target, day)) throw new NotAiredError([target.id]);
  const todo = s.episodes.filter((e) => compareEpisodes(e, target) <= 0 && isAired(e, day) && !s.input.watched.has(e.id));
  return markAndState(ctx, showId, todo.map((e) => e.id));
}

// Coche de saison : tous les épisodes sortis de la saison.
export function markSeason(ctx: Ctx, showId: number, season: number): { marked: number[]; restored: Restored[]; show: ShowState } {
  const s = loadShow(ctx, showId);
  if (!getSeasons(ctx.db, showId).some((x) => x.number === season)) throw new NotFoundError('saison');
  const day = today(ctx);
  const eps = s.episodes.filter((e) => e.season === season);
  const aired = eps.filter((e) => isAired(e, day));
  if (!aired.length) throw new NotAiredError(eps.map((e) => e.id));
  return markAndState(ctx, showId, aired.filter((e) => !s.input.watched.has(e.id)).map((e) => e.id));
}

function markAndState(ctx: Ctx, showId: number, episodeIds: number[]): { marked: number[]; restored: Restored[]; show: ShowState } {
  const { marked, restored } = episodeIds.length ? applyMarks(ctx, episodeIds.map((episodeId) => ({ episodeId }))) : { marked: [], restored: [] };
  return { marked, restored, show: showState(ctx, loadShow(ctx, showId)) };
}
