import type { EpisodeLike, Follow, StatusResult } from './series.ts';

// Listes des écrans « En cours » et « De côté ». Les entrées non suivies (follow null) sont ignorées.

export type ShowEntry<S extends { id: number; name: string }, E extends EpisodeLike> = {
  show: S;
  follow: Follow | null;
  info: StatusResult<E>;
};

const byName = (a: { id: number; name: string }, b: { id: number; name: string }) =>
  a.name.localeCompare(b.name, 'fr') || a.id - b.id;

// À regarder : séries suivies au statut « en cours », par date de sortie du prochain épisode (le plus ancien en haut).
// upNext = les épisodes sortis non vus qui suivent next : le client avance dessus après un swipe sans attendre le serveur.
export function buildToWatch<S extends { id: number; name: string }, E extends EpisodeLike>(entries: readonly ShowEntry<S, E>[], upNextCount = 3) {
  return entries
    .filter((x) => x.follow && x.info.status === 'encours' && x.info.next)
    .map((x) => ({ show: x.show, next: x.info.next as E, upNext: x.info.unwatched.slice(1, 1 + upNextCount), remaining: x.info.remaining }))
    .sort((a, b) => cmp(a.next.airDate, b.next.airDate) || byName(a.show, b.show));
}

// À venir : les 2 prochains épisodes de chaque série suivie qui n'est pas de côté, par date de sortie.
export function buildUpcoming<S extends { id: number; name: string }, E extends EpisodeLike>(entries: readonly ShowEntry<S, E>[], perShow = 2) {
  return entries
    .filter((x) => x.follow && x.info.status !== 'decote')
    .flatMap((x) => x.info.future.slice(0, perShow).map((episode) => ({ show: x.show, episode })))
    .sort((a, b) => cmp(a.episode.airDate, b.episode.airDate) || byName(a.show, b.show)
      || a.episode.season - b.episode.season || a.episode.number - b.episode.number);
}

// Motif affiché sur une carte « De côté ».
export type ShelfReason =
  | { kind: 'manual' }
  | { kind: 'added'; at: string }
  | { kind: 'lastWatched'; at: string; day: string };

// De côté : « Pas commencées » (aucun épisode vu, même mise de côté à la main), par ajout décroissant ;
// « Abandonnées » (au moins un vu), par dernier visionnage décroissant.
export function buildShelf<S extends { id: number; name: string }, E extends EpisodeLike>(entries: readonly ShowEntry<S, E>[]) {
  const cards = entries
    .filter((x) => x.follow && x.info.status === 'decote')
    .map((x) => {
      const follow = x.follow as Follow;
      const reason: ShelfReason = follow.state === 'shelved' ? { kind: 'manual' }
        : !x.info.started ? { kind: 'added', at: follow.addedAt }
        : { kind: 'lastWatched', at: x.info.lastWatchedAt as string, day: x.info.lastWatchedDay as string };
      return { show: x.show, reason, next: x.info.next, remaining: x.info.remaining, addedAt: follow.addedAt, lastWatchedAt: x.info.lastWatchedAt, started: x.info.started };
    });
  const desc = (a: string | null, b: string | null) => (Date.parse(b ?? '') || 0) - (Date.parse(a ?? '') || 0);
  const notStarted = cards.filter((c) => !c.started).sort((a, b) => desc(a.addedAt, b.addedAt) || byName(a.show, b.show));
  const abandoned = cards.filter((c) => c.started).sort((a, b) => desc(a.lastWatchedAt, b.lastWatchedAt) || byName(a.show, b.show));
  const strip = ({ show, reason, next, remaining }: (typeof cards)[number]) => ({ show, reason, next, remaining });
  return { notStarted: notStarted.map(strip), abandoned: abandoned.map(strip) };
}

function cmp(a: string | null, b: string | null): number {
  return (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;
}
