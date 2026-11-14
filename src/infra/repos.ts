import type { Db } from '../db/index.ts';
import type { Role } from '../domain/accounts.ts';
import type { Follow } from '../domain/series.ts';

// Accès SQL du suivi. Les listes d'ids passent en un seul paramètre JSON (json_each) : une requête par lot, pas de N+1.

const ids = (list: readonly number[]) => JSON.stringify(list);
const all = <T>(db: Db, sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as unknown as T[];
const one = <T>(db: Db, sql: string, ...params: (string | number | null)[]) => db.prepare(sql).get(...params) as unknown as T | undefined;

// ---------- utilisateurs ----------

export type UserRow = { id: number; username: string; role: Role; country: string; timezone: string; shelveAfterDays: number };
const USER_COLS = 'u.id, u.username, u.role, u.country, u.timezone, u.shelve_after_days AS shelveAfterDays';

export function getUser(db: Db, id: number): UserRow | undefined {
  return one<UserRow>(db, `SELECT ${USER_COLS} FROM users u WHERE u.id = ?`, id);
}

export type AccountRow = UserRow & { pwHash: string };

export function getAccount(db: Db, id: number): AccountRow | undefined {
  return one<AccountRow>(db, `SELECT ${USER_COLS}, u.pw_hash AS pwHash FROM users u WHERE u.id = ?`, id);
}

export function getAccountByKey(db: Db, key: string): AccountRow | undefined {
  return one<AccountRow>(db, `SELECT ${USER_COLS}, u.pw_hash AS pwHash FROM users u WHERE u.username_key = ?`, key);
}

// pwHash '!' = mot de passe inutilisable (compte à initialiser par un lien de réinitialisation).
export function insertUser(db: Db, u: {
  username: string; usernameKey: string; pwHash: string; role: Role; invitedBy: number | null; createdAt: string;
}): number {
  const row = one<{ id: number }>(db, `INSERT INTO users (username, username_key, pw_hash, role, invited_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, u.username, u.usernameKey, u.pwHash, u.role, u.invitedBy, u.createdAt);
  return (row as { id: number }).id;
}

export function setPasswordHash(db: Db, id: number, pwHash: string): void {
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, id);
}

export function setUserRole(db: Db, id: number, role: Role): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function countAdmins(db: Db): number {
  return (one<{ n: number }>(db, `SELECT count(*) AS n FROM users WHERE role = 'admin'`) as { n: number }).n;
}

// Efface le compte et tout ce qui lui appartient. Ses invitations restent (created_by / used_by passent à NULL).
export function deleteUserAndData(db: Db, id: number): void {
  for (const table of ['watched', 'user_shows', 'push_subscriptions', 'notifications_sent', 'sessions', 'reset_tokens']) db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export type AccountListRow = {
  id: number; username: string; role: Role; createdAt: string; invitedBy: string | null; invitedByDeleted: number;
  followedCount: number; watchedCount: number;
};

// invitedByDeleted : le compte est entré par une invitation dont le créateur a été supprimé.
export function listAccounts(db: Db, id: number | null = null): AccountListRow[] {
  return all<AccountListRow>(db, `SELECT u.id, u.username, u.role, u.created_at AS createdAt, p.username AS invitedBy,
      EXISTS (SELECT 1 FROM invites i WHERE i.used_by = u.id AND i.created_by IS NULL) AS invitedByDeleted,
      (SELECT count(*) FROM user_shows us WHERE us.user_id = u.id) AS followedCount,
      (SELECT count(*) FROM watched w WHERE w.user_id = u.id) AS watchedCount
    FROM users u LEFT JOIN users p ON p.id = u.invited_by
    WHERE ? IS NULL OR u.id = ?
    ORDER BY u.created_at, u.id`, id, id);
}

// ---------- sessions ----------

export type SessionRow = { user: UserRow; expiresAt: string; lastSeenAt: string };

export function insertSession(db: Db, tokenHash: string, userId: number, nowIso: string, expiresAt: string): void {
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash, userId, nowIso, expiresAt, nowIso);
}

export function getSession(db: Db, tokenHash: string): SessionRow | undefined {
  const row = one<UserRow & { expiresAt: string; lastSeenAt: string }>(db, `SELECT ${USER_COLS}, s.expires_at AS expiresAt,
    s.last_seen_at AS lastSeenAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, tokenHash);
  if (!row) return undefined;
  const { expiresAt, lastSeenAt, ...user } = row;
  return { user, expiresAt, lastSeenAt };
}

export function touchSession(db: Db, tokenHash: string, nowIso: string, expiresAt: string): void {
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(nowIso, expiresAt, tokenHash);
}

export function deleteSession(db: Db, tokenHash: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteUserSessions(db: Db, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function deleteExpiredSessions(db: Db, nowIso: string): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
}

// ---------- invitations ----------

export type InviteRow = {
  id: number; createdBy: number | null; createdByName: string | null; createdAt: string; expiresAt: string;
  usedAt: string | null; usedByName: string | null; revokedAt: string | null;
};
const INVITE_SELECT = `SELECT i.id, i.created_by AS createdBy, c.username AS createdByName, i.created_at AS createdAt,
  i.expires_at AS expiresAt, i.used_at AS usedAt, ub.username AS usedByName, i.revoked_at AS revokedAt
  FROM invites i LEFT JOIN users c ON c.id = i.created_by LEFT JOIN users ub ON ub.id = i.used_by`;

export function insertInvite(db: Db, codeHash: string, createdBy: number, nowIso: string, expiresAt: string): number {
  const row = one<{ id: number }>(db, `INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id`,
    codeHash, createdBy, nowIso, expiresAt);
  return (row as { id: number }).id;
}

export function getInvite(db: Db, id: number): InviteRow | undefined {
  return one<InviteRow>(db, `${INVITE_SELECT} WHERE i.id = ?`, id);
}

export function getInviteByHash(db: Db, codeHash: string): InviteRow | undefined {
  return one<InviteRow>(db, `${INVITE_SELECT} WHERE i.code_hash = ?`, codeHash);
}

// Du plus récent au plus ancien.
export function listInvitesBy(db: Db, createdBy: number): InviteRow[] {
  return all<InviteRow>(db, `${INVITE_SELECT} WHERE i.created_by = ? ORDER BY i.created_at DESC, i.id DESC`, createdBy);
}

// Marque l'invitation utilisée si elle est encore en attente. Renvoie false sinon (déjà utilisée, révoquée ou expirée).
export function useInvite(db: Db, id: number, userId: number, nowIso: string): boolean {
  return Number(db.prepare(`UPDATE invites SET used_by = ?, used_at = ?
    WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(userId, nowIso, id, nowIso).changes) === 1;
}

// Sans effet sur un lien utilisé, déjà révoqué ou expiré (son statut reste celui-là).
export function revokeInvite(db: Db, id: number, nowIso: string): void {
  db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?').run(nowIso, id, nowIso);
}

// Révoque les liens encore en attente d'un parrain.
export function revokePendingInvites(db: Db, createdBy: number, nowIso: string): void {
  db.prepare(`UPDATE invites SET revoked_at = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .run(nowIso, createdBy, nowIso);
}

// ---------- réinitialisation du mot de passe ----------

export type ResetRow = { userId: number; username: string; expiresAt: string; usedAt: string | null };

// Remplace tout lien précédent du compte.
export function replaceResetToken(db: Db, tokenHash: string, userId: number, nowIso: string, expiresAt: string): void {
  db.prepare('DELETE FROM reset_tokens WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, nowIso, expiresAt);
}

export function getResetToken(db: Db, tokenHash: string): ResetRow | undefined {
  return one<ResetRow>(db, `SELECT r.user_id AS userId, u.username, r.expires_at AS expiresAt, r.used_at AS usedAt
    FROM reset_tokens r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`, tokenHash);
}

// Marque le lien utilisé s'il est encore valide. Renvoie false sinon.
export function useResetToken(db: Db, tokenHash: string, nowIso: string): boolean {
  return Number(db.prepare('UPDATE reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .run(nowIso, tokenHash, nowIso).changes) === 1;
}

// Liens expirés ou utilisés avant cutoff. Renvoie le nombre de lignes supprimées.
export function deleteStaleResetTokens(db: Db, cutoffIso: string): number {
  return Number(db.prepare('DELETE FROM reset_tokens WHERE expires_at <= ? OR used_at <= ?').run(cutoffIso, cutoffIso).changes);
}

// ---------- export des données ----------

export type ExportShowRow = { showId: number; name: string; state: Follow['state'] };

export function getExportShows(db: Db, userId: number): ExportShowRow[] {
  return all<ExportShowRow>(db, `SELECT s.id AS showId, s.name, us.state FROM user_shows us JOIN shows s ON s.id = us.show_id
    WHERE us.user_id = ? ORDER BY s.name, s.id`, userId);
}

export type ExportWatchedRow = {
  showId: number; episodeId: number; showName: string; season: number; number: number; title: string | null; watchedAt: string;
};

// Retirés compris (removed_at) : l'historique se garde en entier.
export function getExportWatched(db: Db, userId: number): ExportWatchedRow[] {
  return all<ExportWatchedRow>(db, `SELECT e.show_id AS showId, e.id AS episodeId, s.name AS showName, e.season, e.number,
      e.title, w.watched_at AS watchedAt
    FROM watched w JOIN episodes e ON e.id = w.episode_id JOIN shows s ON s.id = e.show_id
    WHERE w.user_id = ? ORDER BY w.watched_at, e.show_id, e.season, e.number`, userId);
}

// ---------- réglages ----------

export type UserSettingsRow = {
  username: string; role: Role; country: string; shelveAfterDays: number; notifHour: number; timezone: string;
};

export function getUserSettings(db: Db, id: number): UserSettingsRow | undefined {
  return one<UserSettingsRow>(db, `SELECT username, role, country, shelve_after_days AS shelveAfterDays,
    notif_hour AS notifHour, timezone FROM users WHERE id = ?`, id);
}

// Champ null = inchangé.
export function updateUserSettings(db: Db, id: number, s: {
  country: string | null; shelveAfterDays: number | null; notifHour: number | null;
}): void {
  db.prepare(`UPDATE users SET country = coalesce(?, country), shelve_after_days = coalesce(?, shelve_after_days),
    notif_hour = coalesce(?, notif_hour) WHERE id = ?`)
    .run(s.country, s.shelveAfterDays, s.notifHour, id);
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

// Séries suivies ou de côté par au moins un utilisateur.
export function listTrackedShowIds(db: Db): number[] {
  return all<{ showId: number }>(db, 'SELECT DISTINCT show_id AS showId FROM user_shows ORDER BY show_id').map((r) => r.showId);
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

// ---------- notifications push ----------

export type PushSubscriptionRow = { endpoint: string; p256dh: string; auth: string };

// Un endpoint appartient au dernier compte (et à la dernière session) qui l'a enregistré.
export function upsertPushSubscription(db: Db, s: {
  endpoint: string; userId: number; sessionHash: string; p256dh: string; auth: string; nowIso: string;
}): void {
  db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, session_hash, p256dh, auth, created_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, session_hash = excluded.session_hash,
      p256dh = excluded.p256dh, auth = excluded.auth, seen_at = excluded.seen_at,
      created_at = CASE WHEN user_id = excluded.user_id THEN created_at ELSE excluded.created_at END`)
    .run(s.endpoint, s.userId, s.sessionHash, s.p256dh, s.auth, s.nowIso, s.nowIso);
}

export function getPushSubscription(db: Db, userId: number, endpoint: string): PushSubscriptionRow | undefined {
  return one<PushSubscriptionRow>(db, 'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint);
}

export function listPushSubscriptions(db: Db, userId: number): PushSubscriptionRow[] {
  return all<PushSubscriptionRow>(db, 'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at', userId);
}

export function deleteUserPushSubscription(db: Db, userId: number, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

// Abonnement refusé par le service push (appli désinstallée, permission retirée).
export function deletePushEndpoint(db: Db, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

// Comptes ayant au moins un appareil abonné.
export function listPushUsers(db: Db): (UserRow & { notifHour: number })[] {
  return all<UserRow & { notifHour: number }>(db, `SELECT ${USER_COLS}, u.notif_hour AS notifHour FROM users u
    WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id) ORDER BY u.id`);
}

export type NotifEpisodeRow = { id: number; showId: number; season: number; number: number; title: string | null };

// Épisodes sortis ce jour-là des séries de user_shows, non vus par l'utilisateur, hors séries déjà notifiées ce jour.
export function getNotifiableEpisodes(db: Db, userId: number, day: string): NotifEpisodeRow[] {
  return all<NotifEpisodeRow>(db, `SELECT e.id, e.show_id AS showId, e.season, e.number, e.title
    FROM user_shows us JOIN episodes e ON e.show_id = us.show_id
    WHERE us.user_id = ? AND e.air_date = ? AND e.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.user_id = us.user_id AND w.episode_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM notifications_sent n WHERE n.user_id = us.user_id AND n.day = ? AND n.show_id = e.show_id)
    ORDER BY e.show_id, e.season, e.number`, userId, day, day);
}

export function insertNotificationSent(db: Db, userId: number, showId: number, day: string, nowIso: string): void {
  db.prepare('INSERT OR IGNORE INTO notifications_sent (user_id, show_id, day, sent_at) VALUES (?, ?, ?, ?)').run(userId, showId, day, nowIso);
}

export function deleteNotificationsSentBefore(db: Db, day: string): void {
  db.prepare('DELETE FROM notifications_sent WHERE day < ?').run(day);
}
