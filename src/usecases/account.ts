import { transaction } from '../db/index.ts';
import {
  countAdmins, deleteUserAndData, getAccount, getExportShows, getExportWatched, getUserSettings, revokePendingInvites,
} from '../infra/repos.ts';
import { verifyPassword } from '../infra/secrets.ts';
import { type Base, type Ctx, AppError, NotFoundError, nowIso, today } from './context.ts';

// Droits RGPD : effacement du compte (art. 17) et portabilité (art. 20).

// Efface l'historique, le suivi, les sessions et les liens de réinitialisation ; révoque les invitations en attente.
// Les comptes invités restent : ils apparaissent comme invités par un « Compte supprimé ».
export function eraseAccount(b: Base, userId: number): void {
  revokePendingInvites(b.db, userId, nowIso(b));
  deleteUserAndData(b.db, userId);
}

// Suppression par l'utilisateur lui-même, mot de passe ressaisi. Le dernier admin ne peut pas se supprimer.
export async function deleteMe(ctx: Ctx, password: string): Promise<void> {
  const account = getAccount(ctx.db, ctx.user.id);
  if (!account) throw new NotFoundError('compte');
  if (!(await verifyPassword(password, account.pwHash))) throw new AppError('wrong_password');
  transaction(ctx.db, () => {
    const current = getAccount(ctx.db, ctx.user.id);
    if (!current) return;
    if (current.role === 'admin' && countAdmins(ctx.db) <= 1) throw new AppError('last_admin');
    eraseAccount(ctx, ctx.user.id);
  });
}

export type ExportData = {
  format: 'suivi-series/1';
  exporte_le: string;
  compte: string;
  reglages: { pays: string; mise_de_cote_jours: number; notifications: { actives: boolean; heure: number } };
  series: { tmdb_id: number; serie: string; etat: 'suivie' | 'de_cote' }[];
  episodes_vus: {
    tmdb_id_serie: number; tmdb_id_episode: number; serie: string; saison: number; episode: number; titre: string | null; vu_le: string;
  }[];
};

// Identifiants TMDB inclus pour permettre un import ailleurs. Épisodes vus triés par date de visionnage.
export function exportData(ctx: Ctx): { filename: string; data: ExportData } {
  const s = getUserSettings(ctx.db, ctx.user.id);
  if (!s) throw new NotFoundError('compte');
  const data: ExportData = {
    format: 'suivi-series/1',
    exporte_le: nowIso(ctx),
    compte: s.username,
    reglages: { pays: s.country, mise_de_cote_jours: s.shelveAfterDays, notifications: { actives: s.notifOn === 1, heure: s.notifHour } },
    series: getExportShows(ctx.db, ctx.user.id).map((r) => ({
      tmdb_id: r.showId, serie: r.name, etat: r.state === 'followed' ? 'suivie' : 'de_cote',
    })),
    episodes_vus: getExportWatched(ctx.db, ctx.user.id).map((r) => ({
      tmdb_id_serie: r.showId, tmdb_id_episode: r.episodeId, serie: r.showName, saison: r.season, episode: r.number,
      titre: r.title, vu_le: r.watchedAt,
    })),
  };
  return { filename: `mes-series-${today(ctx)}.json`, data };
}
