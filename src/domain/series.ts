import { daysBetween, localDate } from './dates.ts';

// État d'une série pour un utilisateur, calculé à la volée (rien n'est stocké hormis la mise de côté manuelle).
export type ShowStatus = 'encours' | 'ajour' | 'terminee' | 'decote';
// Relation affichée par le sélecteur de la fiche série.
export type Relation = 'none' | 'on' | 'shelf';
export const RELATIONS: readonly Relation[] = ['none', 'on', 'shelf'];

// Ligne user_shows ; null = série pas suivie. 'shelved' = mise de côté manuelle.
export type Follow = { state: 'followed' | 'shelved'; addedAt: string; resumedAt: string | null };

export type EpisodeLike = { id: number; season: number; number: number; airDate: string | null };

export type StatusInput<E extends EpisodeLike> = {
  episodes: readonly E[];
  watched: ReadonlyMap<number, string>;   // episode_id → watched_at ; peut contenir d'autres séries
  showStatus: string;                     // shows.status (TMDB)
  follow: Follow | null;
  today: string;                          // jour local de l'utilisateur
  timezone: string;
  shelveAfterDays: number;
};

export type StatusResult<E extends EpisodeLike> = {
  status: ShowStatus;
  next: E | null;                 // premier épisode sorti non vu
  remaining: number;              // épisodes sortis non vus
  future: E[];                    // épisodes non vus à date connue après aujourd'hui
  lastWatchedAt: string | null;
  lastWatchedDay: string | null;
  started: boolean;               // au moins un épisode vu
  seen: number;
  total: number;                  // tous les épisodes connus, sortis ou non
};

const FINISHED = new Set(['ended', 'canceled']);

export function compareEpisodes(a: EpisodeLike, b: EpisodeLike): number {
  return a.season - b.season || a.number - b.number;
}

// Sorti = date connue et ≤ aujourd'hui (le jour même compte).
export function isAired(ep: { airDate: string | null }, today: string): boolean {
  return ep.airDate !== null && ep.airDate <= today;
}

export function computeStatus<E extends EpisodeLike>(input: StatusInput<E>): StatusResult<E> {
  const { watched, today, timezone, follow } = input;
  const list = [...input.episodes].sort(compareEpisodes);
  const unwatched = list.filter((e) => isAired(e, today) && !watched.has(e.id));
  // Un épisode vu peut avoir une date future si TMDB l'a corrigée après coup.
  const future = list.filter((e) => e.airDate !== null && e.airDate > today && !watched.has(e.id));

  let seen = 0;
  let lastWatchedAt: string | null = null;
  for (const e of list) {
    const at = watched.get(e.id);
    if (at === undefined) continue;
    seen++;
    if (lastWatchedAt === null || Date.parse(at) > Date.parse(lastWatchedAt)) lastWatchedAt = at;
  }
  const lastWatchedDay = lastWatchedAt === null ? null : localDate(lastWatchedAt, timezone);

  let status: ShowStatus;
  if (follow?.state === 'shelved') status = 'decote';
  else if (unwatched.length === 0) status = FINISHED.has(input.showStatus) && future.length === 0 ? 'terminee' : 'ajour';
  else {
    // Dernière activité : dernier épisode vu, ajout de la série, ou reprise explicite.
    const refs: string[] = [];
    if (lastWatchedDay) refs.push(lastWatchedDay);
    if (follow) refs.push(localDate(follow.addedAt, timezone));
    if (follow?.resumedAt) refs.push(localDate(follow.resumedAt, timezone));
    const ref = refs.sort().at(-1);
    status = ref !== undefined && daysBetween(ref, today) > input.shelveAfterDays ? 'decote' : 'encours';
  }

  return {
    status,
    next: unwatched[0] ?? null,
    remaining: unwatched.length,
    future,
    lastWatchedAt,
    lastWatchedDay,
    started: seen > 0,
    seen,
    total: list.length,
  };
}

// 'shelf' dès que la série est de côté, à la main ou par inactivité.
export function relationOf(follow: Follow | null, status: ShowStatus): Relation {
  if (!follow) return 'none';
  return status === 'decote' ? 'shelf' : 'on';
}

// Statut affiché sur la position du milieu du sélecteur : celui que la série a, ou aurait, en étant suivie hors mise de côté.
// Si elle n'est pas « on », la passer sur « on » serait une reprise : on la simule à l'instant now.
export function wouldBeStatus<E extends EpisodeLike>(input: StatusInput<E>, now: string): ShowStatus {
  const relation = relationOf(input.follow, computeStatus(input).status);
  const follow: Follow = {
    state: 'followed',
    addedAt: input.follow?.addedAt ?? now,
    resumedAt: relation === 'on' ? (input.follow?.resumedAt ?? null) : now,
  };
  return computeStatus({ ...input, follow }).status;
}
