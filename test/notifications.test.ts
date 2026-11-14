// Notifications push : règles (domaine), tâche horaire (use case), abonnements par appareil (API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/db/index.ts';
import { isDue, isPushEndpoint, isPushKeys, localHour, notificationFor } from '../src/domain/notifications.ts';
import { createApp } from '../src/http/app.ts';
import { tokenHash } from '../src/infra/secrets.ts';
import { upsertPushSubscription } from '../src/infra/repos.ts';
import type { Push, PushResult } from '../src/ports.ts';
import { eraseAccount } from '../src/usecases/account.ts';
import { openSession } from '../src/usecases/auth.ts';
import { sendDueNotifications } from '../src/usecases/notify.ts';
import { addUser } from './helpers/auth.ts';
import { FakeCatalog, epId, seedShow, testDb } from './helpers/fake-catalog.ts';

// Clés de navigateur de forme valide (point P-256 non compressé, secret de 16 octets).
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 9).toString('base64url');
const FCM = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;

// ---------- domaine ----------

test('notificationFor : une par série, épisodes triés, cible = premier épisode', () => {
  const show = { id: 7, name: 'Severance' };
  const one = notificationFor(show, [{ id: 71, season: 2, number: 5, title: 'Le retour' }]);
  assert.deepEqual(one, {
    title: 'Severance', body: 'Nouvel épisode : S2E5 · Le retour', tag: 'show-7',
    open: { show: 7, name: 'Severance', season: 2, number: 5, ep: 71 },
  });
  assert.equal(notificationFor(show, [{ id: 71, season: 2, number: 5, title: null }]).body, 'Nouvel épisode : S2E5');
  const many = notificationFor(show, [
    { id: 74, season: 2, number: 8, title: 'D' }, { id: 71, season: 2, number: 5, title: 'A' }, { id: 72, season: 2, number: 6, title: 'B' },
  ]);
  assert.equal(many.body, '3 nouveaux épisodes : S2E5 à S2E8');
  assert.equal(many.open?.ep, 71);
  assert.throws(() => notificationFor(show, []));
});

test('isPushEndpoint : services push des navigateurs seulement, en https', () => {
  for (const ok of [FCM('a'), 'https://web.push.apple.com/QAbc', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.equal(isPushEndpoint(ok), true, ok);
  for (const bad of ['http://fcm.googleapis.com/fcm/send/a', 'https://192.168.1.1/x', 'https://localhost/x', 'https://evilgoogleapis.com/x',
    'https://googleapis.com.evil.fr/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'pas une url', ''])
    assert.equal(isPushEndpoint(bad), false, bad);
});

test('isPushKeys : p256dh = 65 octets commençant par 4, auth = 16 octets, base64url', () => {
  assert.equal(isPushKeys(P256DH, AUTH), true);
  assert.equal(isPushKeys(Buffer.alloc(65, 7).toString('base64url'), AUTH), false);
  assert.equal(isPushKeys(P256DH, Buffer.alloc(12).toString('base64url')), false);
  assert.equal(isPushKeys(`${P256DH}=`, AUTH), false);
  assert.equal(isPushKeys('', ''), false);
});

test('heure locale et échéance : heure passée = due (rattrapage dans la journée)', () => {
  assert.equal(localHour(new Date('2026-11-13T08:00:00Z'), 'Europe/Paris'), 9);    // hiver : UTC+1
  assert.equal(localHour(new Date('2026-07-13T07:00:00Z'), 'Europe/Paris'), 9);    // été : UTC+2
  assert.equal(localHour(new Date('2026-11-13T23:30:00Z'), 'Europe/Paris'), 0);
  assert.equal(isDue(8, 9), false);
  assert.equal(isDue(9, 9), true);
  assert.equal(isDue(15, 9), true);
});

// ---------- tâche horaire ----------

class FakePush implements Push {
  publicKey = 'cle-publique';
  sent: { endpoint: string; title: string; body: string; ep: number | undefined }[] = [];
  results = new Map<string, PushResult>();
  async send(sub: { endpoint: string }, payload: { title: string; body: string; open: { ep: number } | null }): Promise<PushResult> {
    const r = this.results.get(sub.endpoint) ?? 'sent';
    if (r === 'sent') this.sent.push({ endpoint: sub.endpoint, title: payload.title, body: payload.body, ep: payload.open?.ep });
    return r;
  }
}

function device(db: Db, userId: number, endpoint: string, now = '2026-11-13T06:00:00.000Z'): string {
  const token = openSession({ db, now: new Date(now) }, userId);
  upsertPushSubscription(db, { endpoint, userId, sessionHash: tokenHash(token), p256dh: P256DH, auth: AUTH, nowIso: now });
  return token;
}

const follow = (db: Db, userId: number, showId: number, state = 'followed', addedAt = '2026-11-01T00:00:00.000Z') =>
  db.prepare('INSERT INTO user_shows (user_id, show_id, state, added_at) VALUES (?, ?, ?, ?)').run(userId, showId, state, addedAt);
const watch = (db: Db, userId: number, episodeId: number, at = '2026-11-12T20:00:00.000Z') =>
  db.prepare('INSERT INTO watched (user_id, episode_id, watched_at) VALUES (?, ?, ?)').run(userId, episodeId, at);
const subCount = (db: Db) => (db.prepare('SELECT count(*) AS n FROM push_subscriptions').get() as { n: number }).n;

// 13/11 : jour de sortie. Heure de Paris = UTC+1.
function scene() {
  const db = testDb();
  const push = new FakePush();
  const ben = addUser(db, 'ben');
  seedShow(db, { id: 1, name: 'Severance', seasons: [['2026-10-01'], ['2026-11-13', '2026-11-13', '2026-11-20']] });
  seedShow(db, { id: 2, name: 'Andor', seasons: [['2026-11-12', '2026-11-13']] });
  follow(db, ben, 1);
  follow(db, ben, 2);
  watch(db, ben, epId(1, 1, 1));
  const run = (iso: string) => sendDueNotifications({ db, push, now: () => new Date(iso) });
  return { db, push, ben, run };
}

test('à l\'heure choisie : une notification par série, groupant les épisodes du jour, sur chaque appareil', async () => {
  const { db, push, ben, run } = scene();
  device(db, ben, FCM('tel'));
  device(db, ben, FCM('tablette'));
  assert.equal((await run('2026-11-13T07:59:00.000Z')).notifications, 0);   // 8 h 59 à Paris
  assert.equal(push.sent.length, 0);
  const r = await run('2026-11-13T08:00:00.000Z');
  assert.deepEqual(r, { users: 1, notifications: 2, sent: 4, gone: 0, failed: 0, aborted: false });
  assert.deepEqual(push.sent.filter((x) => x.endpoint === FCM('tel')).map((x) => [x.title, x.body, x.ep]), [
    ['Severance', '2 nouveaux épisodes : S2E1 à S2E2', epId(1, 2, 1)],
    ['Andor', 'Nouvel épisode : S1E2 · Épisode 1x2', epId(2, 1, 2)],
  ]);
  // Heures suivantes du même jour : rien de plus.
  push.sent.length = 0;
  await run('2026-11-13T09:00:00.000Z');
  await run('2026-11-13T22:00:00.000Z');
  assert.equal(push.sent.length, 0);
  // Le 20/11, l'épisode suivant.
  await run('2026-11-20T08:00:00.000Z');
  assert.deepEqual(push.sent.map((x) => [x.endpoint, x.ep]).sort(), [[FCM('tablette'), epId(1, 2, 3)], [FCM('tel'), epId(1, 2, 3)]]);
});

test('périmètre : séries suivies hors De côté, épisodes non vus sortis aujourd\'hui', async () => {
  const { db, push, ben, run } = scene();
  device(db, ben, FCM('tel'));
  seedShow(db, { id: 3, name: 'Mise de côté', seasons: [['2026-11-13']] });
  seedShow(db, { id: 4, name: 'Pas suivie', seasons: [['2026-11-13']] });
  seedShow(db, { id: 5, name: 'Abandonnée', seasons: [['2026-08-01', '2026-11-13']] });
  follow(db, ben, 3, 'shelved');
  watch(db, ben, epId(4, 1, 1), '2026-11-13T06:00:00.000Z');   // vue, mais série pas suivie
  follow(db, ben, 5, 'followed', '2026-07-01T00:00:00.000Z');   // épisode du 01/08 jamais vu : de côté par inactivité
  watch(db, ben, epId(2, 1, 2), '2026-11-13T07:00:00.000Z');   // l'épisode du jour d'Andor, déjà vu
  await run('2026-11-13T10:00:00.000Z');
  assert.deepEqual(push.sent.map((x) => x.title), ['Severance']);
});

test('fuseau de l\'utilisateur : heure et jour locaux', async () => {
  const { db, push, ben, run } = scene();
  db.prepare(`UPDATE users SET timezone = 'America/New_York', notif_hour = 20 WHERE id = ?`).run(ben);
  device(db, ben, FCM('tel'));
  await run('2026-11-13T08:00:00.000Z');   // 3 h à New York
  assert.equal(push.sent.length, 0);
  await run('2026-11-14T01:00:00.000Z');   // 20 h le 13 à New York
  assert.equal(push.sent.length, 2);
});

test('abonnement refusé (410) supprimé ; échec sur tous les appareils = réessayé à l\'heure suivante', async () => {
  const { db, push, ben, run } = scene();
  device(db, ben, FCM('ancien'));
  device(db, ben, FCM('tel'));
  push.results.set(FCM('ancien'), 'gone');
  push.results.set(FCM('tel'), 'failed');
  const r1 = await run('2026-11-13T08:00:00.000Z');
  assert.equal(r1.gone, 1);
  assert.equal(r1.failed, 2);
  assert.equal(r1.notifications, 0);
  assert.equal(subCount(db), 1);
  push.results.delete(FCM('tel'));
  const r2 = await run('2026-11-13T09:00:00.000Z');
  assert.equal(r2.notifications, 2);
  assert.deepEqual(push.sent.map((x) => x.endpoint), [FCM('tel'), FCM('tel')]);
});

test('compte sans appareil abonné : ignoré', async () => {
  const { push, run } = scene();
  assert.equal((await run('2026-11-13T08:00:00.000Z')).users, 0);
  assert.equal(push.sent.length, 0);
});

// ---------- API ----------

const NOW = '2026-11-13T12:00:00.000Z';

function api(withPush = true) {
  const db = testDb();
  const push = new FakePush();
  const app = createApp({ db, catalog: new FakeCatalog(db, []), push: withPush ? push : undefined, now: () => new Date(NOW), siteUrl: 'http://series.test' });
  const req = async (method: string, path: string, cookie?: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const user = (name: string) => {
    const id = addUser(db, name);
    const token = openSession({ db, now: new Date(NOW) }, id);
    return { id, token, cookie: `sid=${token}` };
  };
  const subscription = (endpoint: string) => ({ endpoint, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } });
  const rows = () => db.prepare('SELECT endpoint, user_id AS userId, session_hash AS sessionHash FROM push_subscriptions ORDER BY endpoint').all()
    .map((r) => ({ ...r }));
  return { db, push, req, user, subscription, rows };
}

test('GET /api/push/key : clé publique ; sans clés VAPID → 503 ; sans session → 401', async () => {
  const a = api();
  const u = a.user('ben');
  assert.deepEqual(await a.req('GET', '/api/push/key', u.cookie), { status: 200, body: { publicKey: 'cle-publique' } });
  assert.equal((await a.req('GET', '/api/push/key')).status, 401);
  const b = api(false);
  assert.deepEqual(await b.req('GET', '/api/push/key', b.user('ben').cookie), { status: 503, body: { error: 'push_unavailable' } });
});

test('PUT /api/push/subscription : rattaché à la session, idempotent, l\'appareil passe au dernier compte connecté', async () => {
  const a = api();
  const ben = a.user('ben');
  const lea = a.user('lea');
  assert.equal((await a.req('PUT', '/api/push/subscription', ben.cookie, a.subscription(FCM('tel')))).status, 204);
  assert.equal((await a.req('PUT', '/api/push/subscription', ben.cookie, a.subscription(FCM('tel')))).status, 204);
  assert.deepEqual(a.rows(), [{ endpoint: FCM('tel'), userId: ben.id, sessionHash: tokenHash(ben.token) }]);
  await a.req('PUT', '/api/push/subscription', lea.cookie, a.subscription(FCM('tel')));
  assert.deepEqual(a.rows(), [{ endpoint: FCM('tel'), userId: lea.id, sessionHash: tokenHash(lea.token) }]);
});

test('PUT /api/push/subscription : endpoint hors services push ou clés invalides → 400', async () => {
  const a = api();
  const u = a.user('ben');
  const bad = async (body: unknown, field: string) => assert.deepEqual(await a.req('PUT', '/api/push/subscription', u.cookie, body),
    { status: 400, body: { error: 'invalid_input', field } }, JSON.stringify(body));
  await bad(a.subscription('https://192.168.1.1/admin'), 'endpoint');
  await bad(a.subscription('http://fcm.googleapis.com/x'), 'endpoint');
  await bad({ ...a.subscription(FCM('x')), keys: { p256dh: 'abc', auth: AUTH } }, 'keys');
  await bad({ endpoint: FCM('x') }, 'keys');
  await bad({ ...a.subscription(FCM('x')), autre: 1 }, 'autre');
  assert.deepEqual(a.rows(), []);
});

test('DELETE /api/push/subscription : seulement l\'appareil du compte courant', async () => {
  const a = api();
  const ben = a.user('ben');
  const lea = a.user('lea');
  await a.req('PUT', '/api/push/subscription', ben.cookie, a.subscription(FCM('tel')));
  assert.equal((await a.req('DELETE', '/api/push/subscription', lea.cookie, { endpoint: FCM('tel') })).status, 204);
  assert.equal(a.rows().length, 1);
  assert.equal((await a.req('DELETE', '/api/push/subscription', ben.cookie, { endpoint: FCM('tel') })).status, 204);
  assert.deepEqual(a.rows(), []);
});

test('déconnexion et suppression du compte : abonnements supprimés', async () => {
  const a = api();
  const ben = a.user('ben');
  const ben2 = { cookie: `sid=${openSession({ db: a.db, now: new Date(NOW) }, ben.id)}` };
  await a.req('PUT', '/api/push/subscription', ben.cookie, a.subscription(FCM('tel')));
  await a.req('PUT', '/api/push/subscription', ben2.cookie, a.subscription(FCM('tablette')));
  assert.equal((await a.req('POST', '/api/auth/logout', ben.cookie, {})).status, 204);
  assert.deepEqual(a.rows().map((r) => r.endpoint), [FCM('tablette')]);
  a.db.prepare(`INSERT INTO notifications_sent (user_id, show_id, day, sent_at) VALUES (?, 1, '2026-11-13', ?)`).run(ben.id, NOW);
  eraseAccount({ db: a.db, now: new Date(NOW) }, ben.id);
  assert.deepEqual(a.rows(), []);
  assert.equal((a.db.prepare('SELECT count(*) AS n FROM notifications_sent').get() as { n: number }).n, 0);
});

test('POST /api/push/test : vers l\'appareil donné ; inconnu → 404 ; refusé → abonnement supprimé', async () => {
  const a = api();
  const u = a.user('ben');
  assert.equal((await a.req('POST', '/api/push/test', u.cookie, { endpoint: FCM('tel') })).status, 404);
  await a.req('PUT', '/api/push/subscription', u.cookie, a.subscription(FCM('tel')));
  assert.deepEqual(await a.req('POST', '/api/push/test', u.cookie, { endpoint: FCM('tel') }), { status: 200, body: { result: 'sent' } });
  assert.deepEqual(a.push.sent.map((x) => x.endpoint), [FCM('tel')]);
  a.push.results.set(FCM('tel'), 'gone');
  assert.deepEqual((await a.req('POST', '/api/push/test', u.cookie, { endpoint: FCM('tel') })).body, { result: 'gone' });
  assert.deepEqual(a.rows(), []);
});
