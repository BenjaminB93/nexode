import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, transaction } from './index.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

// Fichiers « NNN-nom.sql », appliqués dans l'ordre. PRAGMA user_version = numéro de la dernière migration appliquée.
// Une migration publiée ne se modifie plus : on en ajoute une nouvelle.
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): number[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = /^(\d+)-[\w-]+\.sql$/.exec(f);
      if (!m) throw new Error(`Nom de migration invalide : ${f}`);
      return { version: Number(m[1]), file: f };
    })
    .sort((a, b) => a.version - b.version);

  files.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations non consécutives : ${m.file} en position ${i + 1}`);
  });

  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const applied: number[] = [];
  for (const m of files) {
    if (m.version <= current) continue;
    const sql = readFileSync(join(dir, m.file), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    applied.push(m.version);
  }
  return applied;
}
