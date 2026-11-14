import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';

function withDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  try {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const version = (db: ReturnType<typeof openDb>) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

test('applique les migrations dans l\'ordre, une seule fois', () => {
  withDir({ '002-b.sql': 'INSERT INTO t VALUES (2);', '001-a.sql': 'CREATE TABLE t (x INTEGER);' }, (dir) => {
    const db = openDb(':memory:');
    assert.deepEqual(migrate(db, dir), [1, 2]);
    assert.deepEqual(migrate(db, dir), []);
    assert.equal(version(db), 2);
    assert.equal((db.prepare('SELECT count(*) n FROM t').get() as { n: number }).n, 1);
  });
});

test('une migration en échec est annulée entièrement', () => {
  withDir({ '001-a.sql': 'CREATE TABLE t (x INTEGER);', '002-b.sql': 'CREATE TABLE u (y INTEGER); INSERT INTO absente VALUES (1);' }, (dir) => {
    const db = openDb(':memory:');
    assert.throws(() => migrate(db, dir));
    assert.equal(version(db), 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'u'").get(), undefined);
  });
});

test('refuse une numérotation non consécutive', () => {
  withDir({ '001-a.sql': 'SELECT 1;', '003-c.sql': 'SELECT 1;' }, (dir) => {
    assert.throws(() => migrate(openDb(':memory:'), dir), /non consécutives/);
  });
});

test('les migrations du projet s\'appliquent sur une base vide', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
});
