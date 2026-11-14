import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { addUser } from './helpers/auth.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli', 'create-admin.ts');
const SITE = 'https://series.test';

function run(dbPath: string, ...args: string[]) {
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DB_PATH: dbPath, SITE_URL: SITE, NODE_ENV: 'test' };
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const linkOf = (out: string) => /^https:\/\/series\.test\/reinitialisation\/([A-Za-z0-9_-]{22})$/m.exec(out)?.[1];

test('CLI create-admin : crée l\'admin sans mot de passe, le lien de réinitialisation permet de le choisir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-admin-'));
  const dbPath = join(dir, 'app.sqlite');
  try {
    const first = run(dbPath, 'Camille');
    assert.equal(first.code, 0, first.err);
    const token = linkOf(first.out);
    assert.ok(token, first.out);

    // Relancé : même compte, nouveau lien qui remplace le précédent.
    const again = run(dbPath, 'camille');
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /déjà présent/);
    const token2 = linkOf(again.out) as string;

    const db = openDb(dbPath);
    try {
      const users = db.prepare('SELECT username, role, pw_hash FROM users').all();
      assert.deepEqual(users.map((u: any) => [u.username, u.role, u.pw_hash]), [['Camille', 'admin', '!']]);
      const app = createApp({ db, siteUrl: SITE });
      assert.equal((await app.request(`/api/auth/reset/${token}`)).status, 404);
      assert.deepEqual(await (await app.request(`/api/auth/reset/${token2}`)).json(), { username: 'Camille' });
      const res = await app.request('/api/auth/reset', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token2, password: 'mot de passe admin' }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as any).me.role, 'admin');

      // Un compte existant non admin n'est pas modifié.
      addUser(db, 'julie');
    } finally {
      db.close();
    }
    const refused = run(dbPath, 'JULIE');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /n'est pas admin/);
    assert.equal(run(dbPath).code, 2);
    assert.equal(run(dbPath, 'a b').code, 2);
    assert.equal(run(dbPath, 'x').code, 2);
    assert.equal(run(dbPath, 'un', 'deux').code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
