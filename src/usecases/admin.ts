import { transaction } from '../db/index.ts';
import { RESET_TTL_MS, type Role, addMs } from '../domain/accounts.ts';
import { type AccountListRow, getUser, listAccounts, replaceResetToken, revokePendingInvites, setUserRole } from '../infra/repos.ts';
import { newToken, tokenHash } from '../infra/secrets.ts';
import { eraseAccount } from './account.ts';
import { type Base, type Ctx, AppError, ForbiddenError, NotFoundError, nowIso } from './context.ts';

// Comptes : réservé à l'admin. Un compte admin ne change pas de rôle et ne se supprime pas par ici.

export type AccountView = {
  id: number; username: string; role: Role; createdAt: string; invitedBy: string | null; invitedByDeleted: boolean;
  followedCount: number; watchedCount: number;
};

const view = (r: AccountListRow): AccountView => ({ ...r, invitedByDeleted: r.invitedByDeleted === 1 });

function requireAdmin(ctx: Ctx): void {
  if (ctx.user.role !== 'admin') throw new ForbiddenError();
}

// Cible existante et non admin.
function nonAdminTarget(ctx: Ctx, id: number): void {
  const u = getUser(ctx.db, id);
  if (!u) throw new NotFoundError('compte');
  if (u.role === 'admin') throw new AppError('is_admin');
}

export function listUsers(ctx: Ctx): AccountView[] {
  requireAdmin(ctx);
  return listAccounts(ctx.db).map(view);
}

// Repasser en Membre révoque les liens encore en attente.
export function setRole(ctx: Ctx, id: number, role: 'membre' | 'parrain'): AccountView {
  requireAdmin(ctx);
  return transaction(ctx.db, () => {
    nonAdminTarget(ctx, id);
    setUserRole(ctx.db, id, role);
    if (role === 'membre') revokePendingInvites(ctx.db, id, nowIso(ctx));
    return view(listAccounts(ctx.db, id)[0] as AccountListRow);
  });
}

// Lien à usage unique, 24 h ; remplace le précédent. Le jeton n'existe en clair qu'ici.
export function createResetToken(b: Base, userId: number): { token: string; expiresAt: string } {
  const token = newToken(16);
  const now = nowIso(b);
  const expiresAt = addMs(now, RESET_TTL_MS);
  transaction(b.db, () => replaceResetToken(b.db, tokenHash(token), userId, now, expiresAt));
  return { token, expiresAt };
}

export function createResetLink(ctx: Ctx, id: number): { token: string; expiresAt: string } {
  requireAdmin(ctx);
  if (!getUser(ctx.db, id)) throw new NotFoundError('compte');
  return createResetToken(ctx, id);
}

export function deleteUser(ctx: Ctx, id: number): void {
  requireAdmin(ctx);
  transaction(ctx.db, () => {
    nonAdminTarget(ctx, id);
    eraseAccount(ctx, id);
  });
}
