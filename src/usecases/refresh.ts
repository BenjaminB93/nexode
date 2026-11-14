import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from '../db/index.ts';
import { deleteExpiredSessions, deleteStaleResetTokens, listTrackedShowIds } from '../infra/repos.ts';
import type { Catalog } from '../ports.ts';

// Maintenance quotidienne : purge des sessions et liens périmés, puis rafraîchissement TMDB des séries suivies ou de côté.

const DAY_MS = 86_400_000;
export const RESET_KEEP_MS = 30 * DAY_MS;   // un lien de réinitialisation expiré ou utilisé reste 30 jours
export const REFRESH_PAUSE_MS = 250;        // entre deux séries, pour rester sobre envers TMDB

export type RefreshReport = { total: number; refreshed: number; failed: number; aborted: boolean };
// purgedResets : null si la purge a échoué ; refresh : null sans catalogue.
export type DailyReport = { purgedResets: number | null; refresh: RefreshReport | null };

export type DailyDeps = {
  db: Db;
  catalog: Catalog | undefined;             // absent (pas de jeton TMDB) : purge seule
  now?: () => Date;
  signal?: AbortSignal;                     // arrêt entre deux séries
  pauseMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  warn?: (message: string) => void;
};

const abortableSleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }).catch(() => {});

// Sessions expirées, et liens de réinitialisation expirés ou utilisés depuis plus de 30 jours. Renvoie le nombre de liens supprimés.
export function purgeExpired(db: Db, now: Date): number {
  deleteExpiredSessions(db, now.toISOString());
  return deleteStaleResetTokens(db, new Date(now.getTime() - RESET_KEEP_MS).toISOString());
}

// Une série à la fois ; un échec est journalisé (id, message) et la suite continue.
export async function refreshTrackedShows(
  { db, catalog, signal, pauseMs = REFRESH_PAUSE_MS, sleep = abortableSleep, warn = console.warn }: DailyDeps & { catalog: Catalog },
): Promise<RefreshReport> {
  const ids = listTrackedShowIds(db);
  const report: RefreshReport = { total: ids.length, refreshed: 0, failed: 0, aborted: false };
  for (const [i, id] of ids.entries()) {
    if (i > 0) await sleep(pauseMs, signal);
    if (signal?.aborted) {
      report.aborted = true;
      break;
    }
    try {
      await catalog.refreshShow(id);
      report.refreshed++;
    } catch (err) {
      report.failed++;
      warn(`rafraîchissement de la série ${id} en échec : ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}

// Purge et rafraîchissement sont indépendants : l'échec de l'une (ex. base verrouillée) n'empêche pas l'autre.
export async function dailyMaintenance(deps: DailyDeps): Promise<DailyReport> {
  let purgedResets: number | null = null;
  try {
    purgedResets = purgeExpired(deps.db, (deps.now ?? (() => new Date()))());
  } catch (err) {
    (deps.warn ?? console.warn)(`purge en échec : ${err instanceof Error ? err.message : String(err)}`);
  }
  const refresh = deps.catalog ? await refreshTrackedShows({ ...deps, catalog: deps.catalog }) : null;
  return { purgedResets, refresh };
}

export function describePurge(purgedResets: number | null): string {
  return purgedResets === null ? 'purge en échec' : `${purgedResets} liens de réinitialisation purgés, sessions expirées purgées`;
}

export function describeRefresh(r: RefreshReport): string {
  return `${r.refreshed}/${r.total} séries rafraîchies, ${r.failed} en échec${r.aborted ? ', interrompu' : ''}`;
}
