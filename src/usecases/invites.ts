import { INVITE_TTL_MS, type InviteStatus, type Role, addMs, canInvite, inviteStatus } from '../domain/accounts.ts';
import { type InviteRow, getInvite, getUser, insertInvite, listInvitesBy, revokeInvite as revokeRow } from '../infra/repos.ts';
import { newToken, tokenHash } from '../infra/secrets.ts';
import { type Ctx, AppError, ForbiddenError, NotFoundError, nowIso } from './context.ts';

// Parrainages : liens d'invitation d'un Parrain ou de l'Admin. Le code n'existe en clair qu'à la création.

export type InviteView = {
  id: number; status: InviteStatus; createdAt: string; expiresAt: string; usedAt: string | null;
  usedBy: string | null; usedByDeleted: boolean;
};

function view(i: InviteRow, now: string): InviteView {
  return {
    id: i.id, status: inviteStatus(i, now), createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: i.usedAt,
    usedBy: i.usedByName, usedByDeleted: i.usedAt !== null && i.usedByName === null,
  };
}

// Rôle relu en base, dans la même section synchrone que l'écriture : une rétrogradation survenue pendant la lecture
// du corps de la requête (après le middleware de session) doit s'appliquer.
function requireInviter(ctx: Ctx): Role {
  const role = getUser(ctx.db, ctx.user.id)?.role;
  if (!role || !canInvite(role)) throw new ForbiddenError();
  return role;
}

// Mes liens, du plus récent au plus ancien (l'admin aussi ne voit que les siens).
export function listInvites(ctx: Ctx): InviteView[] {
  requireInviter(ctx);
  return listInvitesBy(ctx.db, ctx.user.id).map((i) => view(i, nowIso(ctx)));
}

export function createInvite(ctx: Ctx): { invite: InviteView; code: string } {
  requireInviter(ctx);
  const code = newToken(16);
  const now = nowIso(ctx);
  const id = insertInvite(ctx.db, tokenHash(code), ctx.user.id, now, addMs(now, INVITE_TTL_MS));
  return { invite: view(getInvite(ctx.db, id) as InviteRow, now), code };
}

// Révoquer un lien déjà révoqué ou expiré ne change rien. L'admin peut révoquer les liens des autres.
export function revokeInvite(ctx: Ctx, id: number): void {
  const role = requireInviter(ctx);
  const invite = getInvite(ctx.db, id);
  if (!invite || (invite.createdBy !== ctx.user.id && role !== 'admin')) throw new NotFoundError('invitation');
  if (invite.usedAt) throw new AppError('invite_used');
  revokeRow(ctx.db, id, nowIso(ctx));
}
