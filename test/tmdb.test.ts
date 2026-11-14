import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createTmdb, isNotFound, TmdbError, USER_AGENT } from '../src/infra/tmdb.ts';
import { fakeFetch, type FakeReply } from './helpers/fake-tmdb.ts';

const TOKEN = 'jeton-secret-de-test';

function setup(routes: Map<string, unknown>) {
  const { fetch, requests } = fakeFetch(routes);
  const sleeps: number[] = [];
  const tmdb = createTmdb({ token: TOKEN, fetch, sleep: async (ms) => void sleeps.push(ms) });
  return { tmdb, requests, sleeps };
}

// Route qui répond successivement les réponses données (la dernière se répète).
function sequence(...replies: FakeReply[]): () => FakeReply {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)]!;
}

test('envoie jeton, Accept et User-Agent, et construit l\'URL avec les paramètres', async () => {
  const { tmdb, requests } = setup(new Map([['/tv/1?language=fr-FR', { id: 1 }]]));
  assert.deepEqual(await tmdb.get('/tv/1', { language: 'fr-FR', absent: undefined }), { id: 1 });
  assert.equal(requests.length, 1);
  const h = requests[0]!.headers;
  assert.equal(h.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(h.get('accept'), 'application/json');
  assert.equal(h.get('user-agent'), USER_AGENT);
  assert.equal(tmdb.calls(), 1);
});

test('429 : attend le Retry-After puis réessaie', async () => {
  const route = sequence({ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: { ok: true } });
  const { tmdb, sleeps } = setup(new Map([['/x', route]]));
  assert.deepEqual(await tmdb.get('/x'), { ok: true });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(tmdb.calls(), 2);
});

test('5xx : attente croissante, 3 nouveaux essais au plus, puis TmdbError', async () => {
  const { tmdb, sleeps } = setup(new Map([['/x', sequence({ status: 503, body: { status_message: 'indisponible' } })]]));
  const err = await tmdb.get('/x').catch((e: unknown) => e);
  assert.ok(err instanceof TmdbError);
  assert.equal(err.status, 503);
  assert.equal(err.path, '/x');
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(tmdb.calls(), 4);
});

test('404 : pas de nouvel essai, reconnaissable', async () => {
  const { tmdb, sleeps } = setup(new Map());
  const err = await tmdb.get('/tv/0').catch((e: unknown) => e);
  assert.ok(isNotFound(err));
  assert.deepEqual(sleeps, []);
  assert.equal(tmdb.calls(), 1);
});

test('le jeton n\'apparaît dans aucune erreur', async () => {
  const leaky = new Map<string, unknown>([['/auth', () => ({ status: 401, body: { status_message: `Invalid token ${TOKEN}` } })]]);
  const { tmdb } = setup(leaky);
  const httpErr = await tmdb.get('/auth').catch((e: unknown) => e);
  assert.ok(httpErr instanceof TmdbError);
  assert.equal(httpErr.status, 401);
  assert.ok(!inspect(httpErr).includes(TOKEN));
  assert.ok(!JSON.stringify(httpErr).includes(TOKEN));

  const failing = (async () => {
    throw new TypeError(`fetch failed (Bearer ${TOKEN})`);
  }) as typeof fetch;
  const net = createTmdb({ token: TOKEN, fetch: failing, sleep: async () => {} });
  const netErr = await net.get('/x').catch((e: unknown) => e);
  assert.ok(netErr instanceof TmdbError);
  assert.equal(netErr.status, 0);
  assert.equal(net.calls(), 4);
  assert.ok(!inspect(netErr).includes(TOKEN));
});

test('refuse un jeton vide', () => {
  assert.throws(() => createTmdb({ token: '' }), /TMDB_READ_TOKEN/);
});

test('délai dépassé : pas de nouvel essai, TmdbError status 0', async () => {
  const sleeps: number[] = [];
  let n = 0;
  const hanging = (async () => {
    n++;
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as typeof fetch;
  const tmdb = createTmdb({ token: TOKEN, fetch: hanging, sleep: async (ms) => void sleeps.push(ms) });
  const err = await tmdb.get('/x').catch((e: unknown) => e);
  assert.ok(err instanceof TmdbError);
  assert.equal(err.status, 0);
  assert.match(err.message, /délai dépassé/);
  assert.equal(n, 1);
  assert.deepEqual(sleeps, []);
});

test('réponse 200 au corps illisible : nouvel essai, puis TmdbError', async () => {
  const html = (async () => new Response('<html>proxy</html>', { status: 200 })) as typeof fetch;
  const tmdb = createTmdb({ token: TOKEN, fetch: html, sleep: async () => {} });
  const err = await tmdb.get('/x').catch((e: unknown) => e);
  assert.ok(err instanceof TmdbError);
  assert.equal(err.status, 200);
  assert.match(err.message, /réponse illisible/);
  assert.equal(tmdb.calls(), 4);

  let n = 0;
  const flaky = (async () => (n++ === 0 ? new Response('{"tronq', { status: 200 }) : Response.json({ ok: true }))) as typeof fetch;
  const retried = createTmdb({ token: TOKEN, fetch: flaky, sleep: async () => {} });
  assert.deepEqual(await retried.get('/x'), { ok: true });
  assert.equal(retried.calls(), 2);
});

test('délai dépassé pendant la lecture du corps : TmdbError, pas de nouvel essai', async () => {
  const slowBody = (async () => {
    const body = new ReadableStream({ start: (c) => c.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const tmdb = createTmdb({ token: TOKEN, fetch: slowBody, sleep: async () => {} });
  const err = await tmdb.get('/x').catch((e: unknown) => e);
  assert.ok(err instanceof TmdbError);
  assert.equal(err.status, 200);
  assert.match(err.message, /délai dépassé/);
  assert.equal(tmdb.calls(), 1);
});
