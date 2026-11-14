import type { Db } from '../db/index.ts';
import type { Follow } from '../domain/series.ts';

// Accès SQL du suivi. Les listes d'ids passent en un seul paramètre JSON (json_each) : une requête par lot, pas de N+1.

const ids = (list: readonly number[]) => JSON.stringify(list);
const all = <T>(db: Db, sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as unknown as T[];
const one = <T>(db: Db, sql: string, ...params: (string | number | null)[]) => db.prepare(sql).get(...params) as unknown as T | undefined;

// ---------- utilisateurs ----------

export type UserRow = { id: number; username: string; country: string; timezone: string; shelveAfterDays: number };
const USER_COLS = 'id, username, country, timezone, shelve_after_days AS shelveAfterDays';

export function getUser(db: Db, id: number): UserRow | undefined {
  return one<UserRow>(db, `SELECT ${USER_COLS} FROM users WHERE id = ?`, id);
}

// Crée le compte s'il n'existe pas (mot de passe inutilisable), puis le renvoie.
export function ensureUser(db: Db, username: string, nowIso: string): UserRow {
  db.prepare(`INSERT INTO users (username, pw_hash, created_at) VALUES (?, '!', ?) ON CONFLICT (username) DO NOTHING`).run(username, nowIso);
  return one<UserRow>(db, `SELECT ${USER_COLS} FROM users WHERE username = ?`, username) as UserRow;
}

// ---------- catalogue ----------

export type ShowRow = {
  id: number; name: string; originalName: string; overview: string;
  firstAirDate: string | null; status: string; posterPath: string | null;
};
const SHOW_COLS = 'id, name, original_name AS originalName, overview, first_air_date AS firstAirDate, status, poster_path AS posterPath';

export function getShows(db: Db, showIds: readonly number[]): ShowRow[] {
  return all<ShowRow>(db, `SELECT ${SHOW_COLS} FROM shows WHERE id IN (SELECT value FROM json_each(?))`, ids(showIds));
}

export function getShow(db: Db, showId: number): ShowRow | undefined {
  return one<ShowRow>(db, `SELECT ${SHOW_COLS} FROM shows WHERE id = ?`, showId);
}

export type EpisodeRow = {
  id: number; showId: number; season: number; number: number;
  title: string | null; titleIsVo: number; airDate: string | null;
};
const EP_COLS = 'id, show_id AS showId, season, number, title, title_is_vo AS titleIsVo, air_date AS airDate';

// Épisode retiré (removed_at) : vu, puis disparu chez TMDB ; le catalogue le garde pour l'historique.
// Il est exclu de tout ce qui numérote ou compte (statut, saisons) ; getEpisodes et l'historique le voient encore.
const CURRENT = 'removed_at IS NULL';

export function getEpisodesOfShows(db: Db, showIds: readonly number[]): EpisodeRow[] {
  return all<EpisodeRow>(db, `SELECT ${EP_COLS} FROM episodes WHERE show_id IN (SELECT value FROM json_each(?)) AND ${CURRENT}
    ORDER BY show_id, season, number`, ids(showIds));
}

// Retirés compris : un épisode vu puis retiré peut encore être remis en non vu (et l'action annulée).
export function getEpisodes(db: Db, episodeIds: readonly number[]): EpisodeRow[] {
  return all<EpisodeRow>(db, `SELECT ${EP_COLS} FROM episodes WHERE id IN (SELECT value FROM json_each(?))
    ORDER BY show_id, season, number`, ids(episodeIds));
}

export type EpisodeDetailRow = EpisodeRow & { overview: string; runtime: number | null; stillPath: string | null };

export function getSeasonEpisodes(db: Db, showId: number, season: number): EpisodeDetailRow[] {
  return all<EpisodeDetailRow>(db, `SELECT ${EP_COLS}, overview, runtime, still_path AS stillPath
    FROM episodes WHERE show_id = ? AND season = ? AND ${CURRENT} ORDER BY number`, showId, season);
}

export type SeasonRow = { number: number; name: string; overview: string; airDate: string | null; posterPath: string | null };

export function getSeasons(db: Db, showId: number): SeasonRow[] {
  return all<SeasonRow>(db, `SELECT number, name, overview, air_date AS airDate, poster_path AS posterPath
    FROM seasons WHERE show_id = ? ORDER BY number`, showId);
}

export function getSeasonCounts(db: Db, showIds: readonly number[]): Map<number, number> {
  const rows = all<{ showId: number; n: number }>(db, `SELECT show_id AS showId, count(*) AS n FROM seasons
    WHERE show_id IN (SELECT value FROM json_each(?)) GROUP BY show_id`, ids(showIds));
  return new Map(rows.map((r) => [r.showId, r.n]));
}

export type ProviderRow = { season: number; id: number; name: string; logoPath: string | null };

// Plateformes d'une série pour un pays, triées par saison puis priorité.
export function getProviders(db: Db, showId: number, country: string): ProviderRow[] {
  return all<ProviderRow>(db, `SELECT season, provider_id AS id, name, logo_path AS logoPath FROM providers
    WHERE show_id = ? AND country = ? ORDER BY season, priority, provider_id`, showId, country);
}

// ---------- suivi ----------

export type UserShowRow = Follow & { showId: number };
const US_COLS = 'show_id AS showId, state, added_at AS addedAt, resumed_at AS resumedAt';

export function getUserShows(db: Db, userId: number): UserShowRow[] {
  return all<UserShowRow>(db, `SELECT ${US_COLS} FROM user_shows WHERE user_id = ?`, userId);
}

export function getUserShowsFor(db: Db, userId: number, showIds: readonly number[]): UserShowRow[] {
  return all<UserShowRow>(db, `SELECT ${US_COLS} FROM user_shows WHERE user_id = ? AND show_id IN (SELECT value FROM json_each(?))`,
    userId, ids(showIds));
}

export function insertUserShow(db: Db, userId: number, showId: number, state: Follow['state'], addedAt: string): void {
  db.prepare('INSERT INTO user_shows (user_id, show_id, state, added_at) VALUES (?, ?, ?, ?)').run(userId, showId, state, addedAt);
}

export function setUserShowState(db: Db, userId: number, showId: number, state: Follow['state']): void {
  db.prepare('UPDATE user_shows SET state = ? WHERE user_id = ? AND show_id = ?').run(state, userId, showId);
}

export function resumeUserShow(db: Db, userId: number, showId: number, resumedAt: string): void {
  db.prepare(`UPDATE user_shows SET state = 'followed', resumed_at = ? WHERE user_id = ? AND show_id = ?`).run(resumedAt, userId, showId);
}

export function deleteUserShow(db: Db, userId: number, showId: number): void {
  db.prepare('DELETE FROM user_shows WHERE user_id = ? AND show_id = ?').run(userId, showId);
}

// ---------- historique de visionnage ----------

// episode_id → watched_at pour les séries données.
export function getWatchedForShows(db: Db, userId: number, showIds: readonly number[]): Map<number, string> {
  const rows = all<{ episodeId: number; watchedAt: string }>(db, `SELECT w.episode_id AS episodeId, w.watched_at AS watchedAt
    FROM watched w JOIN episodes e ON e.id = w.episode_id
    WHERE w.user_id = ? AND e.show_id IN (SELECT value FROM json_each(?))`, userId, ids(showIds));
  return new Map(rows.map((r) => [r.episodeId, r.watchedAt]));
}

// overwrite = remplacer la date d'un épisode déjà vu. Renvoie true si la ligne a changé.
export function putWatched(db: Db, userId: number, episodeId: number, watchedAt: string, overwrite: boolean): boolean {
  const sql = overwrite
    ? `INSERT INTO watched (user_id, episode_id, watched_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, episode_id) DO UPDATE SET watched_at = excluded.watched_at WHERE watched_at <> excluded.watched_at`
    : `INSERT INTO watched (user_id, episode_id, watched_at) VALUES (?, ?, ?) ON CONFLICT (user_id, episode_id) DO NOTHING`;
  return Number(db.prepare(sql).run(userId, episodeId, watchedAt).changes) > 0;
}

// Renvoie la date supprimée, ou null si l'épisode n'était pas vu.
export function deleteWatched(db: Db, userId: number, episodeId: number): string | null {
  const row = one<{ watchedAt: string }>(db, `DELETE FROM watched WHERE user_id = ? AND episode_id = ? RETURNING watched_at AS watchedAt`,
    userId, episodeId);
  return row?.watchedAt ?? null;
}

export type HistoryRow = {
  episodeId: number; watchedAt: string; showId: number; showName: string; posterPath: string | null;
  season: number; number: number; title: string | null; titleIsVo: number; retired: number;
};
export type HistoryCursor = { watchedAt: string; episodeId: number };

// Tri watched_at décroissant puis episode_id décroissant ; before = dernière ligne de la page précédente.
export function getHistory(db: Db, userId: number, before: HistoryCursor | null, limit: number): HistoryRow[] {
  return all<HistoryRow>(db, `SELECT w.episode_id AS episodeId, w.watched_at AS watchedAt, s.id AS showId, s.name AS showName,
      s.poster_path AS posterPath, e.season, e.number, e.title, e.title_is_vo AS titleIsVo, e.removed_at IS NOT NULL AS retired
    FROM watched w JOIN episodes e ON e.id = w.episode_id JOIN shows s ON s.id = e.show_id
    WHERE w.user_id = ? AND (? IS NULL OR w.watched_at < ? OR (w.watched_at = ? AND w.episode_id < ?))
    ORDER BY w.watched_at DESC, w.episode_id DESC LIMIT ?`,
    userId, before?.watchedAt ?? null, before?.watchedAt ?? null, before?.watchedAt ?? null, before?.episodeId ?? null, limit);
}
