// Version, licence et dépôt de l'appli, lus une fois dans package.json (source unique de la version).
import { readFileSync } from 'node:fs';

// source : adresse du code source (champ « repository » de package.json), null tant qu'il n'est pas publié.
export type AppInfo = { version: string; license: string; source: string | null };

export function readAppInfo(path: URL = new URL('../package.json', import.meta.url)): AppInfo {
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; license?: unknown; repository?: unknown };
  if (typeof pkg.version !== 'string' || typeof pkg.license !== 'string') throw new Error('package.json : version ou licence absente');
  const repo = typeof pkg.repository === 'string' ? pkg.repository
    : pkg.repository && typeof (pkg.repository as { url?: unknown }).url === 'string' ? (pkg.repository as { url: string }).url : null;
  return { version: pkg.version, license: pkg.license, source: repo ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : null };
}

export const APP_INFO: AppInfo = readAppInfo();
