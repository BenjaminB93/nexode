import { getUserSettings, updateUserSettings } from '../infra/repos.ts';
import { type Ctx, NotFoundError } from './context.ts';

// Réglages du Profil. Le fuseau est lu seul : il n'a pas encore de réglage.

export const COUNTRIES = ['FR', 'BE', 'CH', 'CA'] as const;
export const SHELVE_AFTER_DAYS = [15, 30, 60, 90] as const;

export type Country = (typeof COUNTRIES)[number];
export type ShelveAfterDays = (typeof SHELVE_AFTER_DAYS)[number];

export type Settings = {
  username: string; country: string; shelveAfterDays: number; notifOn: boolean; notifHour: number; timezone: string;
};
export type SettingsPatch = { country?: Country; shelveAfterDays?: ShelveAfterDays; notifOn?: boolean; notifHour?: number };

export function getSettings(ctx: Ctx): Settings {
  const row = getUserSettings(ctx.db, ctx.user.id);
  if (!row) throw new NotFoundError('compte');
  return { ...row, notifOn: row.notifOn === 1 };
}

// Champs absents = inchangés. Renvoie les réglages complets après écriture.
export function updateSettings(ctx: Ctx, patch: SettingsPatch): Settings {
  updateUserSettings(ctx.db, ctx.user.id, {
    country: patch.country ?? null,
    shelveAfterDays: patch.shelveAfterDays ?? null,
    notifOn: patch.notifOn === undefined ? null : Number(patch.notifOn),
    notifHour: patch.notifHour ?? null,
  });
  return getSettings(ctx);
}
