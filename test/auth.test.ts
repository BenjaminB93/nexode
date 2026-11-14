// Comptes (étape 4) : sessions, invitations, réinitialisation, rôles, suppression, export, limitation, CSRF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/http/app.ts';
import { FailureLimiter } from '../src/http/rate-limit.ts';
import { HASH_MAX_ACTIVE, HASH_MAX_WAITING, hashPassword, verifyPassword } from '../src/infra/secrets.ts';
import { addUser, sessionCookie } from './helpers/auth.ts';
import { FakeCatalog, epId, seedShow, testDb } from './helpers/fake-catalog.ts';

const NOW = '2026-11-13T12:00:00.000Z';
const SITE = 'http://series.test';   // en https, le cookie serait Secure (testé à part)
const PW = 'mot de passe solide';
const PW_HASH = await hashPassword(PW);
const DAY = 86_400_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Opts = { production?: boolean; trustProxy?: boolean; siteUrl?: string };
type Req = { body?: unknown; cookie?: string; headers?: Record<string, string>; ip?: string };

function setup(opts: Opts = {}) {
  const db = testDb();
  const catalog = new FakeCatalog(db, []);
  let now = new Date(NOW);
  const app = createApp({ db, catalog, now: () => now, siteUrl: opts.siteUrl ?? SITE, production: opts.production, trustProxy: opts.trustProxy });
  const req = async (method: string, path: string, r: Req = {}) => {
    const headers: Record<string, string> = { ...(r.cookie ? { cookie: r.cookie } : {}), ...(r.body === undefined ? {} : { 'content-type': 'application/json' }), ...r.headers };
    const init: RequestInit = { method, headers };
    if (r.body !== undefined) init.body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const env = r.ip ? { incoming: { socket: { remoteAddress: r.ip } } } : undefined;
    const res = await app.request(path, init, env);
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers, cookies: res.headers.getSetCookie() };
  };
  const user = (name: string, role: 'membre' | 'parrain' | 'admin' = 'membre', invitedBy: number | null = null) => {
    const id = addUser(db, name, { role, pwHash: PW_HASH, invitedBy });
    return { id, cookie: sessionCookie(db, id, now.toISOString()) };
  };
  return {
    db, app, req, user,
    now: () => now,
    setNow: (iso: string) => { now = new Date(iso); },
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

// 'sid=…' du Set-Cookie, ou undefined.
const sidOf = (cookies: string[]) => cookies.map((c) => /^sid=([^;]*)/.exec(c)?.[1]).find((v) => v !== undefined);
const cookieOf = (cookies: string[]) => `sid=${sidOf(cookies)}`;
const count = (db: ReturnType<typeof testDb>, sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as { n: number }).n;

// Crée un lien d'invitation et renvoie son code.
async function invite(s: ReturnType<typeof setup>, cookie: string) {
  const r = await s.req('POST', '/api/invites', { cookie });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body, code: (r.body.url as string).split('/').pop() as string };
}

// ---------- connexion, cookie, session ----------

test('connexion : 200 { me }, cookie HttpOnly/Lax/Path=/ 180 j, jeton stocké haché', async () => {
  const s = setup();
  s.user('camille', 'admin');
  const r = await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { me: { username: 'camille', role: 'admin', country: 'FR', shelveAfterDays: 30, notifHour: 9, timezone: 'Europe/Paris' } });
  assert.equal(r.cookies.length, 1);
  const c = r.cookies[0] as string;
  assert.match(c, /^sid=[A-Za-z0-9_-]{43};/);
  assert.match(c, /; Max-Age=15552000/);
  assert.match(c, /; Path=\//);
  assert.match(c, /; HttpOnly/);
  assert.match(c, /; SameSite=Lax/);
  assert.doesNotMatch(c, /Secure/);
  const token = sidOf(r.cookies) as string;
  assert.equal(count(s.db, 'SELECT count(*) n FROM sessions WHERE token_hash = ?', sha256(token)), 1);
  assert.equal(count(s.db, 'SELECT count(*) n FROM sessions WHERE token_hash = ?', token), 0);
  const me = await s.req('GET', '/api/me', { cookie: `sid=${token}` });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'admin');
  // Nom insensible à la casse.
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'CAMILLE', password: PW } })).status, 200);
});

test('connexion en production : cookie Secure', async () => {
  const s = setup({ production: true });
  s.user('camille');
  const r = await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW } });
  assert.equal(r.status, 200);
  assert.match(r.cookies[0] as string, /; Secure/);
});

test('SITE_URL en https sans NODE_ENV=production : cookie Secure quand même (connexion, prolongation, effacement)', async () => {
  const s = setup({ siteUrl: 'https://series.test' });
  const u = s.user('camille');
  const r = await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW } });
  assert.match(r.cookies[0] as string, /; Secure/);
  s.advance(2 * DAY);
  assert.match((await s.req('GET', '/api/me', { cookie: u.cookie })).cookies[0] as string, /^sid=[\w-]{43};.*; Secure/);
  assert.match((await s.req('POST', '/api/auth/logout', { cookie: u.cookie })).cookies[0] as string, /^sid=; Max-Age=0;.*; Secure/);
});

test('connexion refusée : même 401 si le compte n\'existe pas ; compte sans mot de passe (\'!\') ; entrées invalides', async () => {
  const s = setup();
  s.user('camille');
  addUser(s.db, 'sansmdp');
  for (const body of [
    { username: 'camille', password: 'mauvais mot de passe' },
    { username: 'personne', password: PW },
    { username: 'sansmdp', password: '!' },
    { username: 'sansmdp', password: '' },
    { username: '??', password: PW },
  ]) {
    const r = await s.req('POST', '/api/auth/login', { body, ip: `10.0.0.${body.username.length}` });
    assert.equal(r.status, 401, JSON.stringify(body));
    assert.deepEqual(r.body, { error: 'invalid_credentials' });
    assert.equal(r.cookies.length, 0);
    s.advance(5_000);   // verrou du compte après un échec
  }
  assert.deepEqual((await s.req('POST', '/api/auth/login', { body: { username: 'camille' } })).body, { error: 'invalid_input', field: 'password' });
  assert.deepEqual((await s.req('POST', '/api/auth/login', { body: { username: 1, password: PW } })).body, { error: 'invalid_input', field: 'username' });
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW, x: 1 } })).status, 400);
});

test('pas de fixation de session : nouveau jeton à chaque connexion, l\'ancien est fermé', async () => {
  const s = setup();
  s.user('camille');
  const a = await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW } });
  const b = await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW }, cookie: cookieOf(a.cookies) });
  assert.notEqual(sidOf(a.cookies), sidOf(b.cookies));
  assert.equal((await s.req('GET', '/api/me', { cookie: cookieOf(a.cookies) })).status, 401);
  assert.equal((await s.req('GET', '/api/me', { cookie: cookieOf(b.cookies) })).status, 200);
  // Un jeton choisi par le client n'est jamais adopté.
  const forged = 'A'.repeat(43);
  const c = await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW }, cookie: `sid=${forged}` });
  assert.notEqual(sidOf(c.cookies), forged);
});

test('déconnexion : 204, session supprimée, cookie effacé', async () => {
  const s = setup();
  const u = s.user('camille');
  const r = await s.req('POST', '/api/auth/logout', { cookie: u.cookie });
  assert.equal(r.status, 204);
  assert.match(r.cookies[0] as string, /^sid=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax/);
  assert.equal(count(s.db, 'SELECT count(*) n FROM sessions'), 0);
  assert.deepEqual((await s.req('GET', '/api/me', { cookie: u.cookie })).body, { error: 'unauthorized' });
  // Sans session, ou avec un corps JSON vide : 204 aussi.
  assert.equal((await s.req('POST', '/api/auth/logout')).status, 204);
  assert.equal((await s.req('POST', '/api/auth/logout', { body: {} })).status, 204);
});

test('session : expiration à 180 j, durée glissante prolongée au plus une fois par jour', async () => {
  const s = setup();
  const u = s.user('camille');
  const expiresAt = () => (s.db.prepare('SELECT expires_at e FROM sessions').get() as { e: string }).e;
  assert.equal(expiresAt(), new Date(Date.parse(NOW) + 180 * DAY).toISOString());

  s.advance(DAY / 2);
  const early = await s.req('GET', '/api/me', { cookie: u.cookie });
  assert.equal(early.status, 200);
  assert.equal(early.cookies.length, 0, 'pas de prolongation avant un jour');
  assert.equal(expiresAt(), new Date(Date.parse(NOW) + 180 * DAY).toISOString());

  s.setNow(new Date(Date.parse(NOW) + 179 * DAY).toISOString());
  const slide = await s.req('GET', '/api/me', { cookie: u.cookie });
  assert.equal(slide.status, 200);
  assert.match(slide.cookies[0] as string, /^sid=[\w-]{43}; Max-Age=15552000; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.equal(sidOf(slide.cookies), u.cookie.slice(4), 'même jeton, cookie renouvelé');
  assert.equal(expiresAt(), new Date(s.now().getTime() + 180 * DAY).toISOString());

  // 180 j sans aucune requête : expirée, supprimée, cookie effacé.
  s.advance(180 * DAY);
  const gone = await s.req('GET', '/api/me', { cookie: u.cookie });
  assert.equal(gone.status, 401);
  assert.match(gone.cookies[0] as string, /^sid=; Max-Age=0/);
  assert.equal(count(s.db, 'SELECT count(*) n FROM sessions'), 0);
});

test('un seul Set-Cookie sid par réponse : celui de la route prime sur l\'effacement ou la prolongation', async () => {
  const s = setup();
  const sids = (cookies: string[]) => cookies.filter((c) => c.startsWith('sid='));
  s.user('camille');
  s.user('autre', 'admin');

  // Connexion avec un cookie expiré : seulement le nouveau cookie.
  const stale = s.user('camille2');
  s.advance(181 * DAY);
  const login = await s.req('POST', '/api/auth/login', { body: { username: 'camille', password: PW }, cookie: stale.cookie });
  assert.equal(login.status, 200);
  assert.equal(sids(login.cookies).length, 1);
  assert.match(sids(login.cookies)[0] as string, /^sid=[\w-]{43}; Max-Age=15552000/);

  // Session à prolonger, puis déconnexion / suppression du compte : seulement l'effacement.
  const b = s.user('lea');
  s.advance(2 * DAY);
  const logout = await s.req('POST', '/api/auth/logout', { cookie: b.cookie });
  assert.deepEqual(sids(logout.cookies).map((c) => c.split(';')[0]), ['sid=']);
  const c = s.user('max');
  s.advance(2 * DAY);
  const del = await s.req('DELETE', '/api/me', { cookie: c.cookie, body: { password: PW } });
  assert.equal(del.status, 204);
  assert.deepEqual(sids(del.cookies).map((x) => x.split(';')[0]), ['sid=']);
  // Requête ordinaire : la prolongation seule.
  const d = s.user('zoe');
  s.advance(2 * DAY);
  assert.deepEqual(sids((await s.req('GET', '/api/me', { cookie: d.cookie })).cookies).map((x) => x.split(';')[0]), [d.cookie]);
});

// ---------- routes protégées ----------

const PROTECTED: [string, string, unknown?][] = [
  ['GET', '/api/me'], ['PATCH', '/api/me', {}], ['DELETE', '/api/me', { password: PW }], ['GET', '/api/me/export'],
  ['GET', '/api/timeline'], ['GET', '/api/history'], ['GET', '/api/shelf'], ['GET', '/api/my-shows'], ['GET', '/api/search?q=sev'],
  ['GET', '/api/shows/1001'], ['GET', '/api/shows/1001/seasons/1'], ['PUT', '/api/shows/1001/relation', { to: 'on' }],
  ['PUT', '/api/watched/1', {}], ['DELETE', '/api/watched/1'], ['POST', '/api/watched/batch', { on: true, episodeIds: [1] }],
  ['POST', '/api/shows/1001/watched-until', { episodeId: 1 }], ['POST', '/api/shows/1001/seasons/1/watched', {}],
  ['GET', '/api/invites'], ['POST', '/api/invites'], ['DELETE', '/api/invites/1'],
  ['GET', '/api/admin/users'], ['PUT', '/api/admin/users/1/role', { role: 'parrain' }], ['POST', '/api/admin/users/1/reset'],
  ['DELETE', '/api/admin/users/1'],
];

test('sans session (ou cookie inconnu) : 401 unauthorized sur toutes les routes protégées ; /api/health et /api/auth ouverts', async () => {
  const s = setup();
  s.user('camille', 'admin');
  for (const cookie of [undefined, 'sid=inconnu', `sid=${'x'.repeat(43)}`]) {
    for (const [m, p, body] of PROTECTED) {
      const r = await s.req(m, p, { body, cookie });
      assert.equal(r.status, 401, `${m} ${p} ${cookie}`);
      assert.deepEqual(r.body, { error: 'unauthorized' });
      if (cookie) assert.match(r.cookies[0] ?? '', /^sid=; Max-Age=0/, `${m} ${p} : cookie inconnu effacé`);
    }
  }
  assert.equal((await s.req('GET', '/api/health')).status, 200);
  assert.equal((await s.req('GET', '/api/auth/invite/xyz')).status, 404);
  assert.equal((await s.req('GET', '/api/nope')).status, 404);
});

test('rôles : Membre → 403 sur parrainages et comptes ; Parrain → 403 sur comptes', async () => {
  const s = setup();
  const membre = s.user('membre');
  const parrain = s.user('parrain', 'parrain');
  const target = s.user('cible');
  for (const [m, p, body] of PROTECTED.filter(([, p]) => p.startsWith('/api/invites') || p.startsWith('/api/admin'))) {
    const r = await s.req(m, p.replace('/users/1', `/users/${target.id}`), { body, cookie: membre.cookie });
    assert.equal(r.status, 403, `membre ${m} ${p}`);
    assert.deepEqual(r.body, { error: 'forbidden' });
  }
  for (const [m, p, body] of PROTECTED.filter(([, p]) => p.startsWith('/api/admin'))) {
    const r = await s.req(m, p.replace('/users/1', `/users/${target.id}`), { body, cookie: parrain.cookie });
    assert.equal(r.status, 403, `parrain ${m} ${p}`);
  }
  assert.equal(count(s.db, 'SELECT count(*) n FROM invites'), 0);
  assert.equal(count(s.db, 'SELECT count(*) n FROM users'), 3);
});

// ---------- invitations ----------

test('invitation : création (code jamais stocké en clair), consultation, inscription, usage unique', async () => {
  const s = setup();
  const julie = s.user('julie', 'parrain');
  const inv = await invite(s, julie.cookie);
  assert.match(inv.url, /^http:\/\/series\.test\/invitation\/[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(inv.invite, {
    id: inv.invite.id, status: 'pending', createdAt: NOW, expiresAt: '2026-11-20T12:00:00.000Z', usedAt: null, usedBy: null, usedByDeleted: false,
  });
  const stored = s.db.prepare('SELECT code_hash h FROM invites').get() as { h: string };
  assert.equal(stored.h, sha256(inv.code));

  assert.deepEqual((await s.req('GET', `/api/auth/invite/${inv.code}`)).body, { invitedBy: 'julie', expiresAt: '2026-11-20T12:00:00.000Z' });

  const r = await s.req('POST', '/api/auth/signup', { body: { code: inv.code, username: 'Léa', password: 'dix caract' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { me: { username: 'Léa', role: 'membre', country: 'FR', shelveAfterDays: 30, notifHour: 9, timezone: 'Europe/Paris' } });
  assert.match(r.cookies[0] as string, /^sid=[\w-]{43}; Max-Age=15552000; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.equal((await s.req('GET', '/api/me', { cookie: cookieOf(r.cookies) })).body.username, 'Léa');
  const lea = s.db.prepare(`SELECT id, invited_by b, role FROM users WHERE username = 'Léa'`).get() as { id: number; b: number; role: string };
  assert.equal(lea.b, julie.id);
  // Connexion avec le mot de passe choisi.
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'léa', password: 'dix caract' } })).status, 200);

  // Usage unique.
  assert.deepEqual(await s.req('GET', `/api/auth/invite/${inv.code}`).then((x) => [x.status, x.body]), [404, { error: 'invite_invalid' }]);
  const again = await s.req('POST', '/api/auth/signup', { body: { code: inv.code, username: 'autre', password: PW } });
  assert.deepEqual([again.status, again.body], [404, { error: 'invite_invalid' }]);

  const list = await s.req('GET', '/api/invites', { cookie: julie.cookie });
  assert.deepEqual(list.body.invites.map((i: any) => [i.status, i.usedBy, i.usedAt, i.usedByDeleted]), [['used', 'Léa', NOW, false]]);
});

test('invitation : deux inscriptions simultanées avec le même code → une seule réussit', async () => {
  const s = setup();
  const julie = s.user('julie', 'parrain');
  const { code } = await invite(s, julie.cookie);
  const results = await Promise.all(['alice', 'bob', 'carol'].map((username) =>
    s.req('POST', '/api/auth/signup', { body: { code, username, password: PW } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 404, 404]);
  assert.equal(count(s.db, 'SELECT count(*) n FROM users'), 2);

  // Même nom par deux liens différents, en même temps : un seul compte.
  const a = await invite(s, julie.cookie);
  const b = await invite(s, julie.cookie);
  const same = await Promise.all([a.code, b.code].map((c) => s.req('POST', '/api/auth/signup', { body: { code: c, username: 'Zoé', password: PW } })));
  assert.deepEqual(same.map((r) => r.status).sort(), [201, 409]);
  assert.deepEqual((await s.req('GET', '/api/invites', { cookie: julie.cookie })).body.invites.map((i: any) => i.status).sort(), ['pending', 'used', 'used']);
});

test('invitation : expire après 7 jours', async () => {
  const s = setup();
  const julie = s.user('julie', 'parrain');
  const { code } = await invite(s, julie.cookie);
  s.advance(7 * DAY - 1);
  assert.equal((await s.req('GET', `/api/auth/invite/${code}`)).status, 200);
  s.advance(1);
  assert.equal((await s.req('GET', `/api/auth/invite/${code}`)).status, 404);
  assert.deepEqual((await s.req('POST', '/api/auth/signup', { body: { code, username: 'tardif', password: PW } })).body, { error: 'invite_invalid' });
  assert.deepEqual((await s.req('GET', '/api/invites', { cookie: julie.cookie })).body.invites.map((i: any) => i.status), ['expired']);
});

test('invitation : révocation (mes liens ; l\'admin, tous), lien utilisé → 409, autre parrain → 404', async () => {
  const s = setup();
  const julie = s.user('julie', 'parrain');
  const max = s.user('max', 'parrain');
  const admin = s.user('camille', 'admin');
  const a = await invite(s, julie.cookie);
  s.advance(1000);
  const b = await invite(s, julie.cookie);
  s.advance(1000);
  const c = await invite(s, julie.cookie);

  assert.equal((await s.req('DELETE', `/api/invites/${a.invite.id}`, { cookie: julie.cookie })).status, 204);
  assert.equal((await s.req('DELETE', `/api/invites/${a.invite.id}`, { cookie: julie.cookie, body: {} })).status, 204, 'idempotent, corps {} accepté');
  assert.equal((await s.req('DELETE', `/api/invites/${a.invite.id}`, { cookie: julie.cookie, body: { x: 1 } })).status, 400);
  assert.deepEqual((await s.req('GET', `/api/auth/invite/${a.code}`)).body, { error: 'invite_invalid' });
  assert.deepEqual((await s.req('DELETE', `/api/invites/${b.invite.id}`, { cookie: max.cookie })).body, { error: 'not_found' });
  assert.equal((await s.req('DELETE', `/api/invites/${b.invite.id}`, { cookie: admin.cookie })).status, 204);
  assert.equal((await s.req('DELETE', '/api/invites/9999', { cookie: julie.cookie })).status, 404);
  assert.equal((await s.req('DELETE', '/api/invites/abc', { cookie: julie.cookie })).status, 400);

  await s.req('POST', '/api/auth/signup', { body: { code: c.code, username: 'lea', password: PW } });
  const used = await s.req('DELETE', `/api/invites/${c.invite.id}`, { cookie: julie.cookie });
  assert.deepEqual([used.status, used.body], [409, { error: 'invite_used' }]);

  // Du plus récent au plus ancien ; l'admin ne voit que ses propres liens.
  assert.deepEqual((await s.req('GET', '/api/invites', { cookie: julie.cookie })).body.invites.map((i: any) => [i.id, i.status]),
    [[c.invite.id, 'used'], [b.invite.id, 'revoked'], [a.invite.id, 'revoked']]);
  assert.deepEqual((await s.req('GET', '/api/invites', { cookie: admin.cookie })).body, { invites: [] });

  // Révoquer un lien expiré : 204, mais il reste « expiré ».
  const old = await invite(s, julie.cookie);
  s.advance(8 * DAY);
  assert.equal((await s.req('DELETE', `/api/invites/${old.invite.id}`, { cookie: julie.cookie })).status, 204);
  assert.equal((await s.req('GET', '/api/invites', { cookie: julie.cookie })).body.invites[0].status, 'expired');
  assert.equal((s.db.prepare('SELECT revoked_at r FROM invites WHERE id = ?').get(old.invite.id) as { r: string | null }).r, null);
});

test('rétrogradation pendant la lecture du corps de POST /api/invites : le lien n\'est pas créé', async () => {
  const s = setup();
  const julie = s.user('julie', 'parrain');
  const admin = s.user('camille', 'admin');
  // Corps envoyé en deux temps : la session (rôle parrain) est lue avant que le corps ne soit complet.
  let push!: (chunk: string) => void;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { push = (chunk) => { ctrl.enqueue(new TextEncoder().encode(chunk)); if (chunk === '}') ctrl.close(); }; },
  });
  const pending = s.app.request('/api/invites', {
    method: 'POST', body, duplex: 'half',
    headers: { cookie: julie.cookie, 'content-type': 'application/json', 'content-length': '2' },
  } as RequestInit);
  push('{');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const demote = await s.req('PUT', `/api/admin/users/${julie.id}/role`, { cookie: admin.cookie, body: { role: 'membre' } });
  assert.equal(demote.status, 200);
  push('}');
  const res = await pending;
  assert.deepEqual([res.status, await res.json()], [403, { error: 'forbidden' }]);
  assert.equal(count(s.db, 'SELECT count(*) n FROM invites'), 0);
});

test('inscription : validation du nom et du mot de passe, nom unique sans tenir compte de la casse ; le lien reste valable', async () => {
  const s = setup();
  const julie = s.user('julie', 'parrain');
  s.user('Élodie');
  const { code } = await invite(s, julie.cookie);
  const signup = (username: unknown, password: unknown = PW) => s.req('POST', '/api/auth/signup', { body: { code, username, password } });
  for (const username of ['ab', 'a'.repeat(25), 'avec espace', 'émoji😀', 'a/b', '', 'tab\t']) {
    assert.deepEqual((await signup(username)).body, { error: 'invalid_input', field: 'username' }, username);
  }
  for (const password of ['123456789', 'x'.repeat(201), 42]) {
    assert.deepEqual((await signup('valide', password)).body, { error: 'invalid_input', field: 'password' }, String(password));
  }
  for (const username of ['élodie', 'ÉLODIE', 'Élodie']) {
    assert.deepEqual(await signup(username).then((r) => [r.status, r.body]), [409, { error: 'username_taken' }], username);
  }
  assert.deepEqual((await s.req('POST', '/api/auth/signup', { body: { code: 'pas-un-code', username: 'valide', password: PW } })).body, { error: 'invite_invalid' });
  assert.equal((await s.req('POST', '/api/auth/signup', { body: { code, username: 'valide' } })).status, 400);
  // Aucun échec n'a consommé le lien ; nom de 24 caractères avec « _ », « - », « . » et accents, mot de passe de 200 caractères.
  const ok = await signup('Ça_va-très.bien_1234567', 'é'.repeat(200));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.me.username, 'Ça_va-très.bien_1234567');
});

test('repasser un Parrain en Membre révoque ses liens en attente ; rôles attribuables : membre, parrain', async () => {
  const s = setup();
  const admin = s.user('camille', 'admin');
  const julie = s.user('julie', 'parrain');
  const used = await invite(s, julie.cookie);
  await s.req('POST', '/api/auth/signup', { body: { code: used.code, username: 'lea', password: PW } });
  const pending = await invite(s, julie.cookie);

  const r = await s.req('PUT', `/api/admin/users/${julie.id}/role`, { cookie: admin.cookie, body: { role: 'membre' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { user: {
    id: julie.id, username: 'julie', role: 'membre', createdAt: '2026-11-01T00:00:00.000Z', invitedBy: null, invitedByDeleted: false,
    followedCount: 0, watchedCount: 0,
  } });
  assert.deepEqual((await s.req('GET', `/api/auth/invite/${pending.code}`)).body, { error: 'invite_invalid' });
  const statuses = s.db.prepare('SELECT used_at IS NOT NULL u, revoked_at IS NOT NULL r FROM invites ORDER BY id').all();
  assert.deepEqual(statuses.map((x: any) => [x.u, x.r]), [[1, 0], [0, 1]]);
  assert.equal((await s.req('POST', '/api/invites', { cookie: julie.cookie })).status, 403);

  assert.equal((await s.req('PUT', `/api/admin/users/${julie.id}/role`, { cookie: admin.cookie, body: { role: 'parrain' } })).body.user.role, 'parrain');
  assert.deepEqual((await s.req('PUT', `/api/admin/users/${julie.id}/role`, { cookie: admin.cookie, body: { role: 'admin' } })).body, { error: 'invalid_input', field: 'role' });
  assert.deepEqual((await s.req('PUT', `/api/admin/users/${admin.id}/role`, { cookie: admin.cookie, body: { role: 'membre' } })).body, { error: 'is_admin' });
  assert.equal((await s.req('PUT', '/api/admin/users/9999/role', { cookie: admin.cookie, body: { role: 'membre' } })).status, 404);
});

// ---------- réinitialisation ----------

test('réinitialisation : lien 24 h à usage unique, sessions fermées, nouveau mot de passe', async () => {
  const s = setup();
  const admin = s.user('camille', 'admin');
  const lea = s.user('lea');
  const other = sessionCookie(s.db, lea.id, NOW);

  const link = await s.req('POST', `/api/admin/users/${lea.id}/reset`, { cookie: admin.cookie });
  assert.equal(link.status, 201);
  assert.match(link.body.url, /^http:\/\/series\.test\/reinitialisation\/[A-Za-z0-9_-]{22}$/);
  assert.equal(link.body.expiresAt, '2026-11-14T12:00:00.000Z');
  const token = link.body.url.split('/').pop();
  assert.equal((s.db.prepare('SELECT token_hash h FROM reset_tokens').get() as { h: string }).h, sha256(token));

  assert.deepEqual((await s.req('GET', `/api/auth/reset/${token}`)).body, { username: 'lea' });
  assert.deepEqual((await s.req('POST', '/api/auth/reset', { body: { token, password: 'court' } })).body, { error: 'invalid_input', field: 'password' });
  const r = await s.req('POST', '/api/auth/reset', { body: { token, password: 'nouveau mot de passe' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.me.username, 'lea');
  assert.match(r.cookies[0] as string, /^sid=[\w-]{43}; Max-Age=15552000/);
  assert.equal((await s.req('GET', '/api/me', { cookie: lea.cookie })).status, 401);
  assert.equal((await s.req('GET', '/api/me', { cookie: other })).status, 401);
  assert.equal((await s.req('GET', '/api/me', { cookie: cookieOf(r.cookies) })).status, 200);
  assert.equal(count(s.db, 'SELECT count(*) n FROM sessions WHERE user_id = ?', lea.id), 1);
  assert.equal((await s.req('GET', '/api/me', { cookie: admin.cookie })).status, 200, 'les autres comptes gardent leur session');

  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'lea', password: PW } })).status, 401);
  s.advance(5_000);
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'lea', password: 'nouveau mot de passe' } })).status, 200);
  // Usage unique.
  assert.deepEqual((await s.req('GET', `/api/auth/reset/${token}`)).body, { error: 'reset_invalid' });
  assert.deepEqual((await s.req('POST', '/api/auth/reset', { body: { token, password: 'encore un autre' } })).body, { error: 'reset_invalid' });
});

test('réinitialisation : un nouveau lien invalide le précédent ; expiration à 24 h ; compte inconnu → 404', async () => {
  const s = setup();
  const admin = s.user('camille', 'admin');
  const lea = s.user('lea');
  const tokenOf = async () => ((await s.req('POST', `/api/admin/users/${lea.id}/reset`, { cookie: admin.cookie })).body.url as string).split('/').pop() as string;
  const first = await tokenOf();
  const second = await tokenOf();
  assert.equal((await s.req('GET', `/api/auth/reset/${first}`)).status, 404);
  assert.equal((await s.req('GET', `/api/auth/reset/${second}`)).status, 200);
  s.advance(DAY - 1);
  assert.equal((await s.req('GET', `/api/auth/reset/${second}`)).status, 200);
  s.advance(1);
  assert.equal((await s.req('GET', `/api/auth/reset/${second}`)).status, 404);
  assert.equal((await s.req('POST', '/api/auth/reset', { body: { token: second, password: PW } })).status, 404);
  assert.equal((await s.req('POST', '/api/admin/users/9999/reset', { cookie: admin.cookie })).status, 404);
  assert.equal((await s.req('GET', '/api/auth/reset/pas-un-jeton')).status, 404);
});

// ---------- suppression ----------

// Compte avec historique, suivi, sessions, lien de réinitialisation et invitations (une utilisée, une en attente).
async function populated(s: ReturnType<typeof setup>) {
  const admin = s.user('camille', 'admin');
  const julie = s.user('julie', 'parrain', admin.id);
  seedShow(s.db, { id: 1001, name: 'Severance', seasons: [['2026-10-01', '2026-10-08']] });
  await s.req('PUT', '/api/shows/1001/relation', { cookie: julie.cookie, body: { to: 'on' } });
  await s.req('PUT', `/api/watched/${epId(1001, 1, 1)}`, { cookie: julie.cookie, body: {} });
  await s.req('POST', `/api/admin/users/${julie.id}/reset`, { cookie: admin.cookie });
  const used = await invite(s, julie.cookie);
  const lea = await s.req('POST', '/api/auth/signup', { body: { code: used.code, username: 'lea', password: PW } });
  const pending = await invite(s, julie.cookie);
  return { admin, julie, pending, leaCookie: cookieOf(lea.cookies) };
}

test('supprimer mon compte : mot de passe exigé, effacement réel, invités conservés, « Compte supprimé » côté admin', async () => {
  const s = setup();
  const { admin, julie, pending } = await populated(s);
  const wrong = await s.req('DELETE', '/api/me', { cookie: julie.cookie, body: { password: 'pas le bon' } });
  assert.deepEqual([wrong.status, wrong.body], [403, { error: 'wrong_password' }]);
  assert.equal((await s.req('DELETE', '/api/me', { cookie: julie.cookie })).status, 400);
  s.advance(5_000);

  const r = await s.req('DELETE', '/api/me', { cookie: julie.cookie, body: { password: PW } });
  assert.equal(r.status, 204);
  assert.match(r.cookies[0] as string, /^sid=; Max-Age=0/);
  for (const table of ['watched', 'user_shows', 'sessions', 'reset_tokens']) {
    assert.equal(count(s.db, `SELECT count(*) n FROM ${table} WHERE user_id = ?`, julie.id), 0, table);
  }
  assert.equal(count(s.db, 'SELECT count(*) n FROM users WHERE id = ?', julie.id), 0);
  assert.equal((await s.req('GET', '/api/me', { cookie: julie.cookie })).status, 401);
  assert.deepEqual((await s.req('GET', `/api/auth/invite/${pending.code}`)).body, { error: 'invite_invalid' }, 'lien en attente révoqué');

  const users = (await s.req('GET', '/api/admin/users', { cookie: admin.cookie })).body.users;
  assert.deepEqual(users.map((u: any) => [u.username, u.invitedBy, u.invitedByDeleted]), [['camille', null, false], ['lea', null, true]]);
  // Le catalogue n'est pas touché.
  assert.equal(count(s.db, 'SELECT count(*) n FROM episodes'), 2);
});

test('supprimer un compte qui a rejoint : le parrain voit « Compte supprimé » (usedByDeleted)', async () => {
  const s = setup();
  const julie = s.user('julie', 'parrain');
  const inv = await invite(s, julie.cookie);
  const lea = await s.req('POST', '/api/auth/signup', { body: { code: inv.code, username: 'lea', password: PW } });
  assert.equal((await s.req('DELETE', '/api/me', { cookie: cookieOf(lea.cookies), body: { password: PW } })).status, 204);
  assert.deepEqual((await s.req('GET', '/api/invites', { cookie: julie.cookie })).body.invites.map((i: any) => [i.status, i.usedBy, i.usedByDeleted]),
    [['used', null, true]]);
});

test('dernier admin : ne peut pas se supprimer ; avec un second admin, si', async () => {
  const s = setup();
  const admin = s.user('camille', 'admin');
  const r = await s.req('DELETE', '/api/me', { cookie: admin.cookie, body: { password: PW } });
  assert.deepEqual([r.status, r.body], [409, { error: 'last_admin' }]);
  assert.equal((await s.req('GET', '/api/me', { cookie: admin.cookie })).status, 200);
  s.user('second', 'admin');
  assert.equal((await s.req('DELETE', '/api/me', { cookie: admin.cookie, body: { password: PW } })).status, 204);
});

test('admin : liste des comptes, suppression d\'un compte (pas d\'un admin)', async () => {
  const s = setup();
  const { admin, julie, leaCookie } = await populated(s);
  const list = await s.req('GET', '/api/admin/users', { cookie: admin.cookie });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.users.map((u: any) => [u.username, u.role, u.invitedBy, u.invitedByDeleted, u.followedCount, u.watchedCount]), [
    ['camille', 'admin', null, false, 0, 0],
    ['julie', 'parrain', 'camille', false, 1, 1],
    ['lea', 'membre', 'julie', false, 0, 0],
  ]);
  assert.deepEqual(Object.keys(list.body.users[0]).sort(), ['createdAt', 'followedCount', 'id', 'invitedBy', 'invitedByDeleted', 'role', 'username', 'watchedCount']);

  assert.deepEqual((await s.req('DELETE', `/api/admin/users/${admin.id}`, { cookie: admin.cookie })).body, { error: 'is_admin' });
  assert.equal((await s.req('DELETE', '/api/admin/users/9999', { cookie: admin.cookie })).status, 404);
  assert.equal((await s.req('DELETE', `/api/admin/users/${julie.id}`, { cookie: admin.cookie })).status, 204);
  assert.equal((await s.req('GET', '/api/me', { cookie: julie.cookie })).status, 401);
  assert.equal(count(s.db, 'SELECT count(*) n FROM watched WHERE user_id = ?', julie.id), 0);
  assert.equal((await s.req('GET', '/api/me', { cookie: leaCookie })).status, 200);
  assert.deepEqual((await s.req('GET', '/api/admin/users', { cookie: admin.cookie })).body.users.map((u: any) => [u.username, u.invitedBy, u.invitedByDeleted]),
    [['camille', null, false], ['lea', null, true]]);
});

// ---------- export ----------

test('export : fichier JSON en pièce jointe, ids TMDB, épisodes triés par date de visionnage', async () => {
  const s = setup();
  const u = s.user('julie');
  seedShow(s.db, { id: 1001, name: 'Severance', seasons: [['2026-10-01', '2026-10-08']] });
  seedShow(s.db, { id: 1002, name: 'Andor', seasons: [['2026-01-01']] });
  seedShow(s.db, { id: 1003, name: 'Non suivie', seasons: [['2026-01-01']] });
  await s.req('PUT', '/api/shows/1001/relation', { cookie: u.cookie, body: { to: 'on' } });
  await s.req('PUT', '/api/shows/1002/relation', { cookie: u.cookie, body: { to: 'shelf' } });
  await s.req('PATCH', '/api/me', { cookie: u.cookie, body: { country: 'BE', notifHour: 20 } });
  await s.req('PUT', `/api/watched/${epId(1001, 1, 2)}`, { cookie: u.cookie, body: { watchedAt: '2026-11-10T20:00:00Z' } });
  await s.req('PUT', `/api/watched/${epId(1003, 1, 1)}`, { cookie: u.cookie, body: { watchedAt: '2026-11-12T20:00:00Z' } });
  await s.req('PUT', `/api/watched/${epId(1001, 1, 1)}`, { cookie: u.cookie, body: { watchedAt: '2026-11-01T20:00:00Z' } });

  const r = await s.req('GET', '/api/me/export', { cookie: u.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="mes-series-2026-11-13.json"');
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(r.body, {
    format: 'suivi-series/1',
    exporte_le: NOW,
    compte: 'julie',
    reglages: { pays: 'BE', mise_de_cote_jours: 30, notifications: { heure: 20 } },
    series: [{ tmdb_id: 1002, serie: 'Andor', etat: 'de_cote' }, { tmdb_id: 1001, serie: 'Severance', etat: 'suivie' }],
    episodes_vus: [
      { tmdb_id_serie: 1001, tmdb_id_episode: epId(1001, 1, 1), serie: 'Severance', saison: 1, episode: 1, titre: 'Épisode 1x1', vu_le: '2026-11-01T20:00:00.000Z' },
      { tmdb_id_serie: 1001, tmdb_id_episode: epId(1001, 1, 2), serie: 'Severance', saison: 1, episode: 2, titre: 'Épisode 1x2', vu_le: '2026-11-10T20:00:00.000Z' },
      { tmdb_id_serie: 1003, tmdb_id_episode: epId(1003, 1, 1), serie: 'Non suivie', saison: 1, episode: 1, titre: 'Épisode 1x1', vu_le: '2026-11-12T20:00:00.000Z' },
    ],
  });
  // Le nom du fichier suit le jour local de l'utilisateur.
  s.setNow('2026-11-13T23:30:00.000Z');
  assert.equal((await s.req('GET', '/api/me/export', { cookie: u.cookie })).headers.get('content-disposition'), 'attachment; filename="mes-series-2026-11-14.json"');
});

// ---------- limitation des tentatives ----------

test('verrou du compte : 5 s après un échec, même avec le bon mot de passe et depuis une autre adresse', async () => {
  const s = setup();
  s.user('camille');
  const login = (password: string, ip: string) => s.req('POST', '/api/auth/login', { body: { username: 'Camille', password }, ip });
  assert.equal((await login(PW, '10.0.0.1')).status, 200, 'bon mot de passe : connexion immédiate');
  assert.equal((await login('faux', '10.0.0.2')).status, 401);
  const blocked = await login(PW, '10.0.0.3');
  assert.deepEqual([blocked.status, blocked.body], [429, { error: 'too_many_attempts', retryAfter: 5 }]);
  assert.equal(blocked.headers.get('retry-after'), '5');
  s.advance(3_000);
  assert.equal((await login(PW, '10.0.0.3')).body.retryAfter, 2, 'une tentative refusée ne prolonge pas le verrou');
  s.advance(2_000);
  assert.equal((await login(PW, '10.0.0.3')).status, 200);
});

test('adresse bloquée : 10 échecs en 15 min tous comptes confondus ; ses tentatives ne verrouillent plus aucun compte', async () => {
  const s = setup();
  s.user('victime');
  const ip = '198.51.100.7';
  for (let i = 0; i < 10; i++) {
    assert.equal((await s.req('POST', '/api/auth/login', { body: { username: i % 2 ? 'victime' : 'nom' + i, password: 'faux' }, ip })).status, 401);
    s.advance(5_000);
  }
  const blocked = await s.req('POST', '/api/auth/login', { body: { username: 'victime', password: 'faux' }, ip });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.body.retryAfter > 800, 'bloquée environ 15 min');
  // La victime se connecte aussitôt depuis son adresse : l'adresse bloquée n'a pas reverrouillé le compte.
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'victime', password: PW }, ip: '203.0.113.1' })).status, 200);
  s.advance(15 * 60_000);
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'autre', password: 'faux' }, ip })).status, 401, 'débloquée après 15 min');
});

test('limitation par adresse : socket par défaut ; X-Forwarded-For (dernière valeur) seulement avec TRUST_PROXY', async () => {
  const direct = setup();
  for (let i = 0; i < 10; i++) {
    const r = await direct.req('POST', '/api/auth/login', { body: { username: 'nom' + i, password: 'x' }, ip: '192.0.2.1', headers: { 'x-forwarded-for': '198.51.100.' + i } });
    assert.equal(r.status, 401);
  }
  assert.equal((await direct.req('POST', '/api/auth/login', { body: { username: 'autre', password: 'x' }, ip: '192.0.2.1', headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 429,
    'X-Forwarded-For ignoré sans TRUST_PROXY');
  assert.equal((await direct.req('POST', '/api/auth/login', { body: { username: 'autre', password: 'x' }, ip: '192.0.2.2' })).status, 401);

  const proxied = setup({ trustProxy: true });
  let n = 0;
  const fail = (xff: string) => proxied.req('POST', '/api/auth/login', { body: { username: 'n' + n++, password: 'x' }, ip: '172.18.0.2', headers: { 'x-forwarded-for': xff } });
  for (let i = 0; i < 10; i++) assert.equal((await fail('1.2.3.' + i + ', 203.0.113.7')).status, 401);
  assert.equal((await fail('9.9.9.9, 203.0.113.7')).status, 429, 'clé = dernière valeur');
  assert.equal((await fail('203.0.113.7, 203.0.113.8')).status, 401, 'autre client derrière le même proxy');
});

test('limitation des codes : invitations et réinitialisations invalides, par adresse', async () => {
  const s = setup();
  const ip = '192.0.2.10';
  const A = 'a'.repeat(22), B = 'b'.repeat(22), C = 'c'.repeat(22);
  for (let i = 0; i < 3; i++) assert.equal((await s.req('GET', '/api/auth/invite/' + A, { ip })).status, 404);
  assert.equal((await s.req('POST', '/api/auth/signup', { body: { code: B, username: 'abc', password: PW }, ip })).status, 404);
  assert.equal((await s.req('GET', '/api/auth/reset/' + C, { ip })).status, 404);
  for (const r of [
    await s.req('GET', '/api/auth/invite/' + A, { ip }),
    await s.req('POST', '/api/auth/signup', { body: { code: B, username: 'abc', password: PW }, ip }),
    await s.req('GET', '/api/auth/reset/' + C, { ip }),
    await s.req('POST', '/api/auth/reset', { body: { token: C, password: PW }, ip }),
  ]) assert.deepEqual([r.status, r.body.error], [429, 'too_many_attempts']);
  assert.equal((await s.req('GET', '/api/auth/reset/' + C, { ip: '192.0.2.11' })).status, 404);
});

test('supprimer mon compte avec un mauvais mot de passe verrouille le compte 5 s', async () => {
  const s = setup();
  const u = s.user('julie');
  s.user('autre', 'admin');
  assert.equal((await s.req('DELETE', '/api/me', { cookie: u.cookie, body: { password: 'faux' } })).status, 403);
  assert.equal((await s.req('DELETE', '/api/me', { cookie: u.cookie, body: { password: PW } })).status, 429);
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'julie', password: PW } })).status, 429);
  s.advance(5_000);
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'julie', password: PW } })).status, 200);
});

test('FailureLimiter : fenêtre glissante, purge des entrées expirées', () => {
  const l = new FailureLimiter(2, 1000);
  l.fail('a', 0);
  assert.equal(l.retryAfter('a', 0), 0);
  l.fail('a', 500);
  assert.equal(l.retryAfter('a', 500), 1);
  assert.equal(l.retryAfter('a', 999), 1);
  assert.equal(l.retryAfter('a', 1000), 0, 'le premier échec sort de la fenêtre à t = 1000');
  for (let i = 0; i < 100; i++) l.fail(`k${i}`, 2000);
  assert.equal(l.size, 101);
  l.retryAfter('z', 70_000);
  assert.equal(l.size, 0);
  l.fail('b', 0);
  l.fail('b', 0);
  l.forget('b', 0);
  assert.equal(l.retryAfter('b', 0), 0, 'forget retire une seule occurrence');
  l.forget('b', 0);
  assert.equal(l.size, 0);
});

test('tentatives simultanées : une seule évaluée par compte, 10 par adresse (échec compté avant le scrypt)', async () => {
  const s = setup();
  s.user('victime');
  const statuses = async (rs: Promise<{ status: number }>[]) => (await Promise.all(rs)).map((r) => r.status);
  const tally = (xs: number[]) => xs.reduce<Record<number, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

  // Même compte, 20 essais d'un coup depuis 20 adresses, le bon mot de passe en dernier : un seul est évalué.
  const byName = await statuses(Array.from({ length: 20 }, (_, i) =>
    s.req('POST', '/api/auth/login', { body: { username: 'victime', password: i === 19 ? PW : 'faux ' + i }, ip: '10.1.0.' + i })));
  assert.deepEqual(tally(byName), { 401: 1, 429: 19 });

  // Même adresse, comptes différents : 10 évalués.
  const byIp = await statuses(Array.from({ length: 15 }, (_, i) =>
    s.req('POST', '/api/auth/login', { body: { username: 'nom' + i, password: 'faux' }, ip: '10.2.0.1' })));
  assert.deepEqual(tally(byIp), { 401: 10, 429: 5 });

  // Des connexions réussies ne laissent pas d'échec derrière elles.
  for (let i = 0; i < 5; i++) s.user('ami' + i);
  assert.deepEqual(tally(await statuses(Array.from({ length: 5 }, (_, i) =>
    s.req('POST', '/api/auth/login', { body: { username: 'ami' + i, password: PW }, ip: '10.3.0.1' })))), { 200: 5 });
  for (let i = 0; i < 10; i++) assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'x' + i, password: 'faux' }, ip: '10.3.0.1' })).status, 401);
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'x99', password: 'faux' }, ip: '10.3.0.1' })).status, 429);

  // Ressaisie du mot de passe à la suppression : une seule évaluée.
  const u = s.user('julie');
  const del = await statuses(Array.from({ length: 8 }, () => s.req('DELETE', '/api/me', { cookie: u.cookie, body: { password: 'faux' } })));
  assert.deepEqual(tally(del), { 403: 1, 429: 7 });
});

test('scrypt : calculs simultanés bornés ; file pleine → 429 retryAfter 1 immédiat, sans compter d\'échec', async () => {
  const s = setup();
  const n = HASH_MAX_ACTIVE + HASH_MAX_WAITING + 5;
  const rs = await Promise.all(Array.from({ length: n }, (_, i) =>
    s.req('POST', '/api/auth/login', { body: { username: `nom${i}`, password: 'faux' }, ip: `10.4.0.${i}` })));
  const busy = rs.filter((r) => r.status === 429);
  assert.equal(rs.filter((r) => r.status === 401).length, HASH_MAX_ACTIVE + HASH_MAX_WAITING);
  assert.equal(busy.length, 5);
  for (const r of busy) {
    assert.deepEqual(r.body, { error: 'too_many_attempts', retryAfter: 1 });
    assert.equal(r.headers.get('retry-after'), '1');
  }
  // Une requête refusée faute de place n'a pas compté d'échec : 10 échecs encore permis depuis son adresse.
  const ip = `10.4.0.${rs.indexOf(busy[0] as typeof rs[number])}`;
  for (let i = 0; i < 10; i++) assert.equal((await s.req('POST', '/api/auth/login', { body: { username: `y${i}`, password: 'faux' }, ip })).status, 401);
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'y99', password: 'faux' }, ip })).status, 429);
  // La file se vide : tout repasse.
  assert.equal((await s.req('POST', '/api/auth/login', { body: { username: 'z', password: 'faux' }, ip: '10.5.0.1' })).status, 401);
});

// ---------- CSRF ----------

test('CSRF : écriture refusée (403) si Origin ne correspond pas ; lectures et requêtes sans Origin acceptées', async () => {
  const dev = setup();
  const u = dev.user('julie');
  const patch = (origin: string | undefined, s = dev, cookie = u.cookie) =>
    s.req('PATCH', '/api/me', { cookie, body: { notifHour: 8 }, headers: origin ? { origin } : {} });
  assert.deepEqual(await patch('https://evil.test').then((r) => [r.status, r.body]), [403, { error: 'bad_origin' }]);
  assert.equal((await patch('null')).status, 403);
  assert.equal((await patch('http://localhost')).status, 200, 'même hôte que la requête');
  assert.equal((await patch(SITE)).status, 200, 'SITE_URL');
  assert.equal((await patch(undefined)).status, 200);
  assert.equal((await dev.req('GET', '/api/me', { cookie: u.cookie, headers: { origin: 'https://evil.test' } })).status, 200);
  assert.equal((await dev.req('POST', '/api/auth/login', { body: { username: 'julie', password: PW }, headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await dev.req('DELETE', '/api/me', { cookie: u.cookie, body: { password: PW }, headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal(count(dev.db, 'SELECT count(*) n FROM users'), 1);

  const prod = setup({ production: true });
  const p = prod.user('julie');
  assert.equal((await patch('http://localhost', prod, p.cookie)).status, 403, 'en production, seule SITE_URL');
  assert.equal((await patch(SITE, prod, p.cookie)).status, 200);
});

// ---------- pages ----------

test('pages /invitation/:code et /reinitialisation/:token : index.html, sans Referer ni cache', async () => {
  const s = setup();
  for (const path of ['/invitation/abcdefghijklmnopqrstuv', '/reinitialisation/abcdefghijklmnopqrstuv']) {
    const res = await s.app.request(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<!doctype html>/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('fichiers statiques : revalidés à chaque chargement, 304 si inchangés', async () => {
  const s = setup();
  const res = await s.app.request('/app/style.css');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const tag = res.headers.get('etag');
  assert.ok(tag);
  const again = await s.app.request('/app/style.css', { headers: { 'if-none-match': tag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('cache-control'), 'no-cache');
});

test('scrypt : paramètres dans la chaîne, sel aléatoire, \'!\' jamais valide', async () => {
  assert.match(PW_HASH, /^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.notEqual(await hashPassword(PW), PW_HASH);
  assert.equal(await verifyPassword(PW, PW_HASH), true);
  assert.equal(await verifyPassword('autre', PW_HASH), false);
  assert.equal(await verifyPassword('!', '!'), false);
  assert.equal(await verifyPassword('', '!'), false);
});
