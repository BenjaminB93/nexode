import { transaction } from '../db/index.ts';
import {
  SESSION_TOUCH_MS, SESSION_TTL_MS, addMs, inviteStatus, normalizeUsername, passwordLengthOk, usernameKey,
} from '../domain/accounts.ts';
import {
  deleteExpiredSessions, deleteSession, deleteUserSessions, getAccountByKey, getInviteByHash, getResetToken, getSession,
  insertSession, insertUser, setPasswordHash, touchSession, useInvite, useResetToken,
} from '../infra/repos.ts';
import { hashPassword, newToken, tokenHash, tokenShape, verifyPassword } from '../infra/secrets.ts';
import { type Base, type User, AppError, InvalidInputError, nowIso } from './context.ts';

// Connexion, sessions, inscription par invitation, réinitialisation du mot de passe.
// Un code ou jeton inconnu, utilisé, expiré ou révoqué donne la même erreur.

export const SESSION_TOKEN = tokenShape(32);
const CODE = tokenShape(16);

export type Opened = { userId: number; token: string };

// Nouveau jeton à chaque appel (pas de fixation de session). Purge au passage les sessions expirées.
export function openSession(b: Base, userId: number): string {
  const token = newToken(32);
  const now = nowIso(b);
  deleteExpiredSessions(b.db, now);
  insertSession(b.db, tokenHash(token), userId, now, addMs(now, SESSION_TTL_MS));
  return token;
}

export type Resolved = { user: User; extended: boolean };

// Session valide → utilisateur. Durée glissante : prolongée au plus une fois par jour (extended = cookie à renvoyer).
export function resolveSession(b: Base, token: string): Resolved | null {
  if (!SESSION_TOKEN.test(token)) return null;
  const hash = tokenHash(token);
  const s = getSession(b.db, hash);
  if (!s) return null;
  const now = nowIso(b);
  if (s.expiresAt <= now) {
    deleteSession(b.db, hash);
    return null;
  }
  const extended = b.now.getTime() - Date.parse(s.lastSeenAt) >= SESSION_TOUCH_MS;
  if (extended) touchSession(b.db, hash, now, addMs(now, SESSION_TTL_MS));
  return { user: s.user, extended };
}

export function closeSession(b: Base, token: string): void {
  if (SESSION_TOKEN.test(token)) deleteSession(b.db, tokenHash(token));
}

// Même erreur, et même temps de calcul, que le compte existe ou non.
export async function login(b: Base, username: string, password: string): Promise<Opened> {
  const name = normalizeUsername(username);
  const account = name === null ? undefined : getAccountByKey(b.db, usernameKey(name));
  const ok = await verifyPassword(password, account?.pwHash ?? '!');
  if (!account || !ok) throw new AppError('invalid_credentials');
  return { userId: account.id, token: openSession(b, account.id) };
}

function pendingInvite(b: Base, code: string) {
  const invite = CODE.test(code) ? getInviteByHash(b.db, tokenHash(code)) : undefined;
  if (!invite || inviteStatus(invite, nowIso(b)) !== 'pending') throw new AppError('invite_invalid');
  return invite;
}

export function inviteInfo(b: Base, code: string): { invitedBy: string | null; expiresAt: string } {
  const invite = pendingInvite(b, code);
  return { invitedBy: invite.createdByName, expiresAt: invite.expiresAt };
}

export function checkPassword(password: string): void {
  if (!passwordLengthOk(password)) throw new InvalidInputError('password');
}

// Nouveau compte Membre, invité par le créateur du lien. Le lien est consommé dans la même transaction que la création.
export async function signup(b: Base, code: string, username: string, password: string): Promise<Opened> {
  pendingInvite(b, code);
  const name = normalizeUsername(username);
  if (name === null) throw new InvalidInputError('username');
  checkPassword(password);
  const key = usernameKey(name);
  if (getAccountByKey(b.db, key)) throw new AppError('username_taken');
  const pwHash = await hashPassword(password);
  return transaction(b.db, () => {
    // Relu après le hachage asynchrone : une inscription concurrente a pu consommer le lien ou prendre le nom.
    const invite = pendingInvite(b, code);
    if (getAccountByKey(b.db, key)) throw new AppError('username_taken');
    const userId = insertUser(b.db, { username: name, usernameKey: key, pwHash, role: 'membre', invitedBy: invite.createdBy, createdAt: nowIso(b) });
    if (!useInvite(b.db, invite.id, userId, nowIso(b))) throw new AppError('invite_invalid');
    return { userId, token: openSession(b, userId) };
  });
}

function validReset(b: Base, token: string) {
  const reset = tokenShape(16).test(token) ? getResetToken(b.db, tokenHash(token)) : undefined;
  if (!reset || reset.usedAt || reset.expiresAt <= nowIso(b)) throw new AppError('reset_invalid');
  return reset;
}

export function resetInfo(b: Base, token: string): { username: string } {
  return { username: validReset(b, token).username };
}

// Nouveau mot de passe : le lien est consommé, toutes les sessions du compte sont fermées, une nouvelle est ouverte.
export async function resetPassword(b: Base, token: string, password: string): Promise<Opened> {
  validReset(b, token);
  checkPassword(password);
  const pwHash = await hashPassword(password);
  return transaction(b.db, () => {
    const { userId } = validReset(b, token);
    if (!useResetToken(b.db, tokenHash(token), nowIso(b))) throw new AppError('reset_invalid');
    setPasswordHash(b.db, userId, pwHash);
    deleteUserSessions(b.db, userId);
    return { userId, token: openSession(b, userId) };
  });
}
