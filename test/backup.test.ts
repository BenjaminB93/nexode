import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { backupDb, backupName } from '../src/cli/backup.ts';
import { addUser } from './helpers/auth.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli', 'backup.ts');

function run(dbPath: string, ...args: string[]) {
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DB_PATH: dbPath, NODE_ENV: 'test' };
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const users = (path: string) => {
  const db = openDb(path);
  try {
    return db.prepare('SELECT id, username, role FROM users ORDER BY id').all();
  } finally {
    db.close();
  }
};

test('backupName : date UTC sans « : », extension conservée', () => {
  const now = new Date('2026-11-14T15:30:12.345Z');
  assert.equal(backupName('/data/app.sqlite', now), 'app-2026-11-14_153012Z.sqlite');
  assert.equal(backupName('data/base', now), 'base-2026-11-14_153012Z.sqlite');
});

test('backup : copie lisible et identique, base ouverte en écriture ; refuse d\'écraser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-'));
  const dbPath = join(dir, 'app.sqlite');
  const live = openDb(dbPath);
  try {
    migrate(live);
    addUser(live, 'camille', { role: 'admin' });
    addUser(live, 'julie');

    // Connexion de l'appli toujours ouverte (WAL) pendant la sauvegarde.
    const now = new Date('2026-11-14T15:30:12Z');
    const copy = backupDb(dbPath, join(dir, 'sauvegardes'), now);
    assert.deepEqual(users(copy), users(dbPath));
    assert.equal(users(copy).length, 2);

    assert.throws(() => backupDb(dbPath, join(dir, 'sauvegardes'), now), /existe déjà/);
    assert.throws(() => backupDb(join(dir, 'absente.sqlite'), dir, now), /introuvable/);
  } finally {
    live.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI backup : dossier par défaut à côté de la base, dossier en argument, usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-cli-'));
  const dbPath = join(dir, 'app.sqlite');
  try {
    const db = openDb(dbPath);
    migrate(db);
    addUser(db, 'camille');
    db.close();

    const byDefault = run(dbPath);
    assert.equal(byDefault.code, 0, byDefault.err);
    const [file] = readdirSync(join(dir, 'sauvegardes'));
    assert.match(file as string, /^app-\d{4}-\d{2}-\d{2}_\d{6}Z\.sqlite$/);
    assert.match(byDefault.out, /^Sauvegarde : .+app-.+\.sqlite \(\d+\.\d (Ko|Mo)\)$/m);
    assert.deepEqual(users(join(dir, 'sauvegardes', file as string)), users(dbPath));

    const custom = run(dbPath, join(dir, 'ailleurs'));
    assert.equal(custom.code, 0, custom.err);
    assert.equal(readdirSync(join(dir, 'ailleurs')).length, 1);

    assert.equal(run(join(dir, 'absente.sqlite')).code, 1);
    assert.equal(run(dbPath, 'a', 'b').code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
