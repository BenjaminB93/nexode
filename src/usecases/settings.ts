import type { Role } from '../domain/accounts.ts';
import type { Db } from '../db/index.ts';
import { getUserSettings, updateUserSettings } from '../infra/repos.ts';
import { type Ctx, AppError, InvalidInputError, NotFoundError, UpstreamError } from './context.ts';

// Réglages du Profil. Le fuseau est lu seul : il n'a pas encore de réglage.

export const SHELVE_AFTER_DAYS = [15, 30, 60, 90] as const;

export type ShelveAfterDays = (typeof SHELVE_AFTER_DAYS)[number];

// « me » de l'API : compte courant et ses réglages.
export type Settings = {
  username: string; role: Role; country: string; shelveAfterDays: number; notifOn: boolean; notifHour: number; timezone: string;
};
export type SettingsPatch = { country?: string; shelveAfterDays?: ShelveAfterDays; notifOn?: boolean; notifHour?: number };

export function getMe(db: Db, userId: number): Settings {
  const row = getUserSettings(db, userId);
  if (!row) throw new NotFoundError('compte');
  return { ...row, notifOn: row.notifOn === 1 };
}

export const getSettings = (ctx: Ctx): Settings => getMe(ctx.db, ctx.user.id);

// Pays proposés : ceux couverts par JustWatch.
export async function listCountries(ctx: Ctx): Promise<string[]> {
  try {
    return await ctx.catalog.regions();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new UpstreamError(`liste des pays indisponible : ${(err as Error).message}`);
  }
}

// Champs absents = inchangés. Renvoie les réglages complets après écriture.
export async function updateSettings(ctx: Ctx, patch: SettingsPatch): Promise<Settings> {
  if (patch.country !== undefined && !(await listCountries(ctx)).includes(patch.country)) throw new InvalidInputError('country');
  updateUserSettings(ctx.db, ctx.user.id, {
    country: patch.country ?? null,
    shelveAfterDays: patch.shelveAfterDays ?? null,
    notifOn: patch.notifOn === undefined ? null : Number(patch.notifOn),
    notifHour: patch.notifHour ?? null,
  });
  return getSettings(ctx);
}
