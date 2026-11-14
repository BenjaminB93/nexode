// Sauvegarde à chaud de la base SQLite (VACUUM INTO : copie cohérente même pendant que l'appli écrit).
// Le fichier est nommé d'après la date UTC ; un fichier existant n'est jamais écrasé.
// Usage : node --env-file-if-exists=.env src/cli/backup.ts [dossier]   (défaut : « sauvegardes » à côté de la base)
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { loadConfig } from '../config.ts';

// Ex. app-2026-11-14_153012Z.sqlite (sans « : », interdit dans les noms de fichiers Windows).
export function backupName(dbPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace('T', '_').replaceAll(':', '');
  const ext = extname(dbPath) || '.sqlite';
  return `${basename(dbPath, extname(dbPath))}-${stamp}${ext}`;
}

// Copie dbPath dans dir et rend le chemin du fichier créé.
export function backupDb(dbPath: string, dir: string, now: Date = new Date()): string {
  if (!existsSync(dbPath)) throw new Error(`Base introuvable : ${dbPath}`);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, backupName(dbPath, now));
  if (existsSync(target)) throw new Error(`Le fichier existe déjà, rien n'est écrasé : ${target}`);
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch (err) {
    rmSync(target, { force: true });
    throw err;
  } finally {
    db.close();
  }
  return target;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error('Usage : node --env-file-if-exists=.env src/cli/backup.ts [dossier]');
    process.exit(2);
  }
  const { dbPath } = loadConfig();
  const dir = args[0] ?? join(dirname(dbPath), 'sauvegardes');
  try {
    const file = backupDb(dbPath, dir);
    console.log(`Sauvegarde : ${file} (${formatSize(statSync(file).size)})`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
