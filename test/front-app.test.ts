// Logique du front (public/app) testable sans navigateur : App instancié sans rendu, API remplacée par des doubles.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Modules JS du front, sans déclarations de types : import dynamique (type any).
const load = (p: string): Promise<any> => import(new URL(p, import.meta.url).href);
const { App } = await load('../public/app/app.js');
const { api } = await load('../public/app/api.js');
const S = await load('../public/app/store.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// setState synchrone (pas de rendu), toasts relevés au lieu d'être affichés.
function makeApp() {
  const app = new App({});
  app.setState = (u: any) => {
    const p = typeof u === 'function' ? u(app.state) : u;
    if (p) app.state = { ...app.state, ...p };
  };
  app.toasts = [] as { text: string; undo: (() => void) | null }[];
  app.toast = (text: string, undo?: () => void) => { app.toasts.push({ text, undo: undo || null }); };
  return app;
}

async function idle(app: any) {
  for (let i = 0; i < 50; i++) {
    await tick();
    if (!app.running && !app.queue.length && !app.waiting.length) return;
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ep = { id: 11, season: 1, number: 2, title: 'T', titleIsVo: false, airDate: '2026-01-01' };
const showState = (over: Record<string, unknown> = {}) => ({
  id: 1, relation: 'on', status: 'encours', wouldBeStatus: 'encours', next: null, remaining: 0, seen: 2, total: 2, ...over,
});

test('Annuler un « vu » qui n’a rien marqué (déjà vu côté serveur) n’efface pas le visionnage', async (t: TestContext) => {
  const app = makeApp();
  t.mock.method(api, 'mark', async () => ({ marked: [], shows: [showState()] }));
  const unmark = t.mock.method(api, 'unmark', async () => ({ removed: [], shows: [] }));
  app.markEp(1, ep, 'vu');
  await idle(app);
  app.toasts[0].undo();
  await idle(app);
  assert.equal(unmark.mock.callCount(), 0);
});

test('Annuler un « vu » réellement enregistré envoie DELETE', async (t: TestContext) => {
  const app = makeApp();
  t.mock.method(api, 'mark', async () => ({ marked: [ep.id], shows: [showState()] }));
  const unmark = t.mock.method(api, 'unmark', async () => ({ removed: [], shows: [] }));
  app.markEp(1, ep, 'vu');
  await idle(app);
  app.toasts[0].undo();
  await idle(app);
  assert.equal(unmark.mock.callCount(), 1);
});

test('Après un lot suivi d’une autre écriture sur la même série, l’historique est relu et remplacé (curseur compris)', async (t: TestContext) => {
  const app = makeApp();
  app.state.hist = { items: [], next: 'ancien', loading: false, failed: false };
  t.mock.method(api, 'watchedUntil', async () => ({ marked: [1, 2, 3], show: showState({ remaining: 1 }) }));
  t.mock.method(api, 'mark', async () => ({ marked: [ep.id], shows: [showState()] }));
  const page = { items: [{ episodeId: 3, watchedAt: '2026-11-14T10:00:00.002Z' }], next: 'nouveau' };
  const history = t.mock.method(api, 'history', async () => page);
  app.markUntil(1, { ...ep, id: 3 }, 3);
  app.markEp(1, ep, 'vu');
  await idle(app);
  await idle(app);
  assert.equal(history.mock.callCount(), 1);
  assert.equal(history.mock.calls[0]?.arguments[0], null);
  assert.equal(app.state.hist.next, 'nouveau');
  assert.deepEqual(app.state.hist.items, page.items);
});

test('Recherche : une réponse arrivée après une nouvelle frappe est ignorée', async (t: TestContext) => {
  const app = makeApp();
  const calls: { q: string; d: ReturnType<typeof deferred<any>> }[] = [];
  t.mock.method(api, 'search', (q: string) => { const d = deferred<any>(); calls.push({ q, d }); return d.promise; });
  app.searchInput('ab');
  clearTimeout(app.searchTimer);
  app.runSearch('ab');                       // le délai de 300 ms est écoulé, la requête part
  app.searchInput('abc');                    // frappe pendant la requête
  clearTimeout(app.searchTimer);
  calls[0]!.d.resolve({ results: [{ id: 9 }] });
  await tick();
  assert.equal(app.state.search.results, null);
  assert.equal(app.state.search.loading, true);
  assert.equal(app.state.search.q, 'abc');
});

test('Recherche : une espace ajoutée ne périme pas la requête en cours', async (t: TestContext) => {
  const app = makeApp();
  const calls: ReturnType<typeof deferred<any>>[] = [];
  t.mock.method(api, 'search', () => { const d = deferred<any>(); calls.push(d); return d.promise; });
  app.searchInput('ab');
  clearTimeout(app.searchTimer);
  app.runSearch('ab');
  app.searchInput('ab ');
  await wait(320);                           // aucun nouveau départ après le délai
  assert.equal(calls.length, 1);
  calls[0]!.resolve({ results: [{ id: 9 }] });
  await tick();
  assert.deepEqual(app.state.search.results, [{ id: 9 }]);
  assert.equal(app.state.search.q, 'ab ');
});

test('Fin d’un swipe validé : ne remet pas à zéro un autre geste commencé entre-temps', async () => {
  const app = makeApp();
  let committed = 0;
  app.g = { id: 'A', commit: () => { committed++; }, mode: 'h' };
  app.state.drag = { id: 'A', dx: 200 };
  app.endSwipe(false);
  assert.equal(app.state.drag.release, true);
  app.state.drag = { id: 'B', dx: 40 };
  await wait(260);
  assert.equal(committed, 1);
  assert.deepEqual(app.state.drag, { id: 'B', dx: 40 });
});

test('Coche d’une saison complète non chargée : échec de chargement → toast', async (t: TestContext) => {
  const app = makeApp();
  app.state.shows = { 1: { name: 'X', seasons: [{ number: 2, aired: 3, seen: 3 }] } };
  t.mock.method(api, 'season', async () => { throw new Error('réseau'); });
  app.askSeason(1, 2);
  await idle(app);
  assert.deepEqual(app.toasts.map((x: any) => x.text), ['Chargement impossible']);
});

test('Coche d’une saison complète non chargée pendant une écriture : la confirmation arrive après la relecture', async (t: TestContext) => {
  const app = makeApp();
  app.state.shows = { 1: { name: 'X', seasons: [{ number: 2, aired: 1, seen: 1 }] } };
  const write = deferred<any>();
  t.mock.method(api, 'setRelation', () => write.promise);
  const season = {
    show: { id: 1, name: 'X', relation: 'on' }, season: { number: 2 }, providers: [],
    episodes: [{ id: 21, season: 2, number: 1, aired: true, watchedAt: '2026-11-01T10:00:00.000Z', watchedDay: '2026-11-01', untilCount: 0 }],
  };
  const read = t.mock.method(api, 'season', async () => season);
  app.setRelation(1, 'on');
  app.askSeason(1, 2);
  await tick(); await tick();
  assert.equal(app.state.confirm, null);
  write.resolve({ show: showState() });
  await idle(app);
  await wait(5);
  assert.equal(read.mock.callCount(), 2);   // première réponse jetée (écriture en cours), relue ensuite
  assert.equal(app.state.confirm?.title, 'Saison 2 non vue ?');
});

test('Retour système sur une entrée plus profonde que la pile : recalage de l’historique', (t: TestContext) => {
  const app = makeApp();
  const go = t.mock.fn();
  (globalThis as any).history = { go };
  t.after(() => { delete (globalThis as any).history; });
  app.handlePop({ state: { nav: 2 } });
  assert.deepEqual(go.mock.calls[0]?.arguments, [-2]);
  app.state.stack = [{ type: 'show', show: 1 }];
  app.handlePop({ state: { nav: 0 } });
  assert.deepEqual(app.state.stack, []);
  assert.equal(go.mock.callCount(), 1);
});

test('Entrée dans un onglet : les listes de la visite précédente ne sont pas réaffichées', () => {
  const app = makeApp();
  app.loadTab = () => {};
  app.state.tl = { entries: {}, order: [], upcoming: [] };
  app.state.hist = { items: [], next: null };
  app.state.shelf = { cards: {}, notStarted: [], abandoned: [] };
  app.goTab('profil');
  assert.notEqual(app.state.tl, null);
  app.goTab('encours');
  assert.equal(app.state.tl, null);
  assert.equal(app.state.hist, null);
  assert.equal(app.pendingScroll, 'anchor');
  app.goTab('decote');
  assert.equal(app.state.shelf, null);
});

test('Retour sur un écran recouvert : même position de défilement, appliquée quand ses données sont là', () => {
  const app = makeApp();
  const el = { scrollTop: 0 };
  app.mainEl = { querySelector: () => el };
  app.state.tab = 'series';
  app.state.mine = { rows: [] };
  el.scrollTop = 480;
  app.push({ type: 'show', show: 5 });
  el.scrollTop = 120;
  app.push({ type: 'season', show: 5, season: 12 });
  el.scrollTop = 0;
  app.trimTo(1);
  app.restoreScroll();
  assert.equal(el.scrollTop, 0);                // fiche pas encore chargée : on attend
  app.state.shows = { 5: { name: 'X', seasons: [] } };
  app.restoreScroll();
  assert.equal(el.scrollTop, 120);
  el.scrollTop = 0;
  app.trimTo(0);
  app.restoreScroll();
  assert.equal(el.scrollTop, 480);
});

test('De côté : une série swipée à jour reste « Repasse dans En cours » après la réponse du serveur', () => {
  const card = { show: { id: 1 }, reason: { kind: 'inactive', day: '2026-09-01' }, next: null, remaining: 0, back: true, relation: 'shelf' };
  const s = { tl: null, shelf: { cards: { 1: card }, notStarted: [], abandoned: [1] }, mine: null, shows: {}, seasons: {}, search: { results: null } };
  const on = S.applyShowState(s, showState({ status: 'ajour', relation: 'on' }));
  assert.equal(on.patch.shelf.cards[1].back, true);
  const shelf = S.applyShowState(s, showState({ status: 'decote', relation: 'shelf', remaining: 2 }));
  assert.equal(shelf.patch.shelf.cards[1].back, false);
});

// ---------- comptes ----------
const A = await load('../public/app/auth.js');
const F = await load('../public/app/format.js');
const { ApiError, onUnauthorized } = await load('../public/app/api.js');

test('Pages ouvertes par un lien : invitation, réinitialisation, le reste est l’appli', () => {
  assert.deepEqual(A.parseAuthRoute('/invitation/abc123'), { screen: 'signup', code: 'abc123' });
  assert.deepEqual(A.parseAuthRoute('/reinitialisation/t0k%2Den/'), { screen: 'reset', token: 't0k-en' });
  assert.equal(A.parseAuthRoute('/'), null);
  assert.equal(A.parseAuthRoute('/invitation/'), null);
  assert.equal(A.parseAuthRoute('/invitation/a/b'), null);
  assert.equal(A.parseAuthRoute('/invitation/%E0'), null);
});

test('Nom d’utilisateur : 3 à 24 lettres (accents compris), chiffres, _ - . ; message seulement sur un caractère refusé ou trop long', () => {
  assert.equal(A.nameOk('Léa_2.b-c'), true);
  assert.equal(A.nameOk('ab'), false);
  assert.equal(A.nameOk('a'.repeat(25)), false);
  assert.equal(A.nameOk('a b c'), false);
  assert.equal(A.cleanName('  Léa '), 'Léa');          // é saisi en deux caractères → un seul
  assert.equal(A.nameProblem('ab'), null);
  assert.equal(A.nameProblem('a@'), A.NAME_RULE);
  assert.equal(A.nameProblem('a'.repeat(25)), A.NAME_RULE);
  assert.equal(A.passwordOk('123456789'), false);
  assert.equal(A.passwordOk('1234567890'), true);
});

test('Messages d’erreur des formulaires de compte', () => {
  assert.equal(A.authErrorText(new ApiError(429, 'too_many_attempts', undefined, 61)), 'Trop de tentatives : réessaie dans 2 min');
  assert.equal(A.authErrorText(new ApiError(401, 'invalid_credentials')), 'Nom d’utilisateur ou mot de passe incorrect');
  assert.equal(A.authErrorText(new ApiError(403, 'wrong_password')), 'Mot de passe incorrect');
  assert.equal(A.authErrorField(new ApiError(409, 'username_taken')), 'name');
  assert.equal(A.authErrorField(new ApiError(400, 'invalid_input', 'password')), 'password');
});

test('Export : nom de fichier tiré de Content-Disposition ; dates du serveur ramenées au jour local', () => {
  assert.equal(A.fileNameFrom('attachment; filename="mes-series-2026-11-14.json"', 'x.json'), 'mes-series-2026-11-14.json');
  assert.equal(A.fileNameFrom(null, 'x.json'), 'x.json');
  assert.equal(F.dayOf('2026-11-14', 'Europe/Paris'), '2026-11-14');
  assert.equal(F.dayOf('2026-11-14 23:30:00', 'Europe/Paris'), '2026-11-15');   // format SQLite, UTC
  assert.equal(F.dayOf('2026-11-14T23:30:00.000Z', 'America/New_York'), '2026-11-14');
});

test('API : un 401 d’une route protégée signale la fin de session, pas une réponse partie avant la connexion', async (t: TestContext) => {
  let n = 0;
  onUnauthorized(() => { n++; });
  t.after(() => onUnauthorized(null));
  const pending: ((r: Response) => void)[] = [];
  t.mock.method(globalThis, 'fetch', (url: string) => {
    if (String(url).endsWith('/timeline')) return new Promise<Response>((r) => pending.push(r));
    if (String(url).endsWith('/auth/login')) return Promise.resolve(Response.json({ me: { username: 'x' } }));
    return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }));
  });
  await assert.rejects(api.me(), (e: any) => e.status === 401 && e.code === 'unauthorized');
  assert.equal(n, 1);
  const stale = api.timeline();                       // partie avant la connexion
  await api.login('x', 'y');
  pending[0]!(Response.json({ error: 'unauthorized' }, { status: 401 }));
  await assert.rejects(stale);
  assert.equal(n, 1);
});

test('API : 429 porte retryAfter ; /auth/login en 401 ne déclenche pas la fin de session', async (t: TestContext) => {
  let n = 0;
  onUnauthorized(() => { n++; });
  t.after(() => onUnauthorized(null));
  const res = [Response.json({ error: 'invalid_credentials' }, { status: 401 }), Response.json({ error: 'too_many_attempts', retryAfter: 30 }, { status: 429 })];
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(res.shift()));
  await assert.rejects(api.login('a', 'b'), (e: any) => e.code === 'invalid_credentials');
  await assert.rejects(api.login('a', 'b'), (e: any) => e.retryAfter === 30);
  assert.equal(n, 0);
});

test('Fin de session : état remis à zéro une seule fois, la réponse d’une écriture partie avant est ignorée', async (t: TestContext) => {
  const app = makeApp();
  const write = deferred<any>();
  t.mock.method(api, 'setRelation', () => write.promise);
  app.state.me = { username: 'x', role: 'membre' };
  app.state.mine = { rows: [{ id: 1, relation: 'none', seen: 0 }] };
  app.setRelation(1, 'on');
  app.signedOut();
  app.state.auth = null;                             // setState de Preact n'est pas encore appliqué au 2e 401
  app.signedOut();
  assert.equal(app.epoch, 1);
  app.state.auth = { screen: 'login' };
  assert.equal(app.state.me, null);
  assert.equal(app.state.mine, null);
  app.state.mine = { rows: [] };                     // un autre compte s'est connecté entre-temps
  write.resolve({ show: showState() });
  await idle(app);
  assert.deepEqual(app.state.mine, { rows: [] });
  assert.equal(app.queue.length, 0);
  assert.equal(app.running, false);
});

test('Connexion : erreur affichée sous le formulaire, puis entrée dans l’appli', async (t: TestContext) => {
  const app = makeApp();
  const tabs: string[] = [];
  app.loadTab = (x: string) => { tabs.push(x); };
  app.state.auth = { screen: 'login' };
  app.state.form = { ...app.state.form, name: ' max ', pw: 'secret' };
  const login = t.mock.method(api, 'login', async () => { throw new ApiError(401, 'invalid_credentials'); });
  app.submitAuth();
  await tick();
  assert.deepEqual(login.mock.calls[0]?.arguments, ['max', 'secret']);
  assert.equal(app.state.form.error, 'Nom d’utilisateur ou mot de passe incorrect');
  assert.equal(app.state.form.busy, false);
  login.mock.mockImplementation(async () => ({ me: { username: 'max', role: 'membre' } }));
  app.submitAuth();
  await tick();
  assert.equal(app.state.auth, null);
  assert.equal(app.state.me.username, 'max');
  assert.deepEqual(tabs, ['encours']);
});

test('Inscription : lien devenu invalide pendant la saisie → page « Lien invalide »', async (t: TestContext) => {
  const app = makeApp();
  t.mock.method(api, 'invite', async () => ({ invitedBy: 'Julie', expiresAt: '2026-11-20T00:00:00Z' }));
  app.openAuthRoute({ screen: 'signup', code: 'c0de' });
  await tick();
  assert.equal(app.state.auth.info.invitedBy, 'Julie');
  app.state.form = { ...app.state.form, name: 'Léa', pw: '0123456789' };
  t.mock.method(api, 'signup', async () => { throw new ApiError(404, 'invite_invalid'); });
  app.submitAuth();
  await tick();
  assert.equal(app.state.auth.screen, 'invalid');
});

test('Lien de réinitialisation inconnu, utilisé ou expiré : page « Lien invalide » dès l’ouverture', async (t: TestContext) => {
  const app = makeApp();
  t.mock.method(api, 'resetInfo', async () => { throw new ApiError(404, 'reset_invalid'); });
  app.openAuthRoute({ screen: 'reset', token: 't' });
  await tick();
  assert.equal(app.state.auth.screen, 'invalid');
});

test('Supprimer mon compte : mauvais mot de passe → message ; sinon retour à la connexion', async (t: TestContext) => {
  const app = makeApp();
  app.state.me = { username: 'x', role: 'membre' };
  const del = t.mock.method(api, 'deleteMe', async () => { throw new ApiError(403, 'wrong_password'); });
  app.askDeleteSelf();
  app.setDelSelf({ pw: 'faux' });
  app.confirmDeleteSelf();
  await tick();
  assert.equal(app.state.delSelf.error, 'Mot de passe incorrect');
  assert.equal(app.state.delSelf.busy, false);
  del.mock.mockImplementation(async () => null);
  app.setDelSelf({ pw: 'bon' });
  app.confirmDeleteSelf();
  await tick();
  assert.deepEqual(app.state.auth, { screen: 'login' });
  assert.equal(app.state.delSelf, null);
  assert.deepEqual(app.toasts.map((x: any) => x.text), ['Compte supprimé']);
});

test('Parrainages : créer un lien ouvre la feuille de partage ; révoquer met le lien à jour ; un lien qui vient de servir est relu', async (t: TestContext) => {
  const app = makeApp();
  app.state.invites = [];
  const invite = { id: 7, status: 'pending', createdAt: '2026-11-14T10:00:00Z', expiresAt: '2026-11-21T10:00:00Z', usedAt: null, usedBy: null, usedByDeleted: false };
  t.mock.method(api, 'createInvite', async () => ({ invite, url: 'https://s.example/invitation/abc' }));
  app.createInvite();
  await tick();
  assert.equal(app.state.linkSheet.url, 'https://s.example/invitation/abc');
  assert.equal(app.state.linkSheet.inviteId, 7);
  assert.equal(app.state.invites.length, 1);
  t.mock.method(api, 'revokeInvite', async () => null);
  app.revokeInvite(7);
  await tick(); await tick();
  assert.equal(app.state.invites[0].status, 'revoked');
  assert.equal(app.state.linkSheet, null);
  app.state.invites = [invite];
  t.mock.method(api, 'revokeInvite', async () => { throw new ApiError(409, 'invite_used'); });
  const reload = t.mock.method(api, 'invites', async () => ({ invites: [{ ...invite, status: 'used', usedBy: 'Léa' }] }));
  app.revokeInvite(7);
  await idle(app); await tick();
  assert.equal(reload.mock.callCount(), 1);
  assert.equal(app.state.invites[0].status, 'used');
  assert.deepEqual(app.toasts.map((x: any) => x.text), ['Lien révoqué', 'Ce lien vient de servir']);
});

test('Écrans de compte : chaque état se construit sans erreur (chargement, données, erreur)', async () => {
  const V = await load('../public/app/views/account.js');
  const { viewAuth } = await load('../public/app/views/auth.js');
  const { viewProfil } = await load('../public/app/views/profil.js');
  const app = makeApp();
  const st = app.state;
  for (const auth of [{ screen: 'login' }, { screen: 'signup', code: 'c' }, { screen: 'signup', code: 'c', info: { invitedBy: null } },
    { screen: 'reset', token: 't', info: { username: 'x' } }, { screen: 'reset', token: 't', infoFailed: true }, { screen: 'invalid' }]) {
    assert.ok(viewAuth(app, { ...st, auth, form: { ...st.form, name: 'a@', error: 'e', bad: 'name' } }));
    assert.ok(app.render({}, { ...st, auth }));
  }
  const invites = [
    { id: 1, status: 'pending', createdAt: '2026-11-14 10:00:00', expiresAt: '2026-11-21 10:00:00', usedAt: null, usedBy: null, usedByDeleted: false },
    { id: 2, status: 'used', createdAt: '2026-11-01T10:00:00Z', expiresAt: '2026-11-08T10:00:00Z', usedAt: '2026-11-02T10:00:00Z', usedBy: 'Léa', usedByDeleted: false },
    { id: 3, status: 'used', createdAt: '2026-11-01T10:00:00Z', expiresAt: '2026-11-08T10:00:00Z', usedAt: '2026-11-02T10:00:00Z', usedBy: null, usedByDeleted: true },
    { id: 4, status: 'revoked', createdAt: '2026-10-01T10:00:00Z', expiresAt: '2026-10-08T10:00:00Z', usedAt: null, usedBy: null, usedByDeleted: false },
    { id: 5, status: 'expired', createdAt: '2026-10-01T10:00:00Z', expiresAt: '2026-10-08T10:00:00Z', usedAt: null, usedBy: null, usedByDeleted: false },
  ];
  const users = [
    { id: 1, username: 'Ben', role: 'admin', createdAt: '2026-11-01T10:00:00Z', invitedBy: null, invitedByDeleted: false, followedCount: 3, watchedCount: 40 },
    { id: 2, username: 'Léa', role: 'membre', createdAt: '2026-11-02T10:00:00Z', invitedBy: null, invitedByDeleted: true, followedCount: 0, watchedCount: 0 },
  ];
  const me = { username: 'Ben', role: 'admin', country: 'FR', shelveAfterDays: 30, notifHour: 9, timezone: 'Europe/Paris' };
  for (const s of [{ ...st, invites: null, users: null }, { ...st, invites: null, users: null, errs: { invites: true, users: true } }, { ...st, invites, users }]) {
    assert.ok(V.viewInvites(app, s));
    assert.ok(V.viewAdmin(app, s));
    assert.ok(viewProfil(app, { ...s, me }));
    assert.ok(viewProfil(app, { ...s, me: null }));
    for (const push of [null, 'on', 'off', 'denied', 'install', 'unsupported', 'unavailable']) assert.ok(viewProfil(app, { ...s, me, push, pushBusy: false }));
  }
  assert.ok(V.linkSheetView(app, { title: 'T', sub: 's', url: 'https://x/invitation/a', inviteId: 1, copied: 'ok' }));
  assert.ok(V.linkSheetView(app, { title: 'T', sub: 's', url: null, inviteId: 1 }));
  assert.ok(V.accountSheet(app, { ...st, users }, users[1]));
  assert.ok(V.exportSheetView(app, { data: null }));
  assert.ok(V.exportSheetView(app, { data: { preview: '{}', sub: 'JSON', text: '{}', filename: 'f.json' } }));
  assert.ok(V.deleteSelfSheet(app, { pw: '', show: false, busy: false, error: 'Mot de passe incorrect' }));
  const full = { ...st, me, invites, users, account: 2, stack: [{ type: 'admin', show: 0 }], linkSheet: { title: 'T', sub: 's', url: null },
    exportSheet: { data: null }, delSelf: { pw: '', show: false, busy: false, error: null } };
  assert.ok(app.render({}, full));
  assert.ok(app.render({}, { ...full, stack: [{ type: 'invites', show: 0 }] }));
});

test('Comptes : seule la réponse au dernier choix de rôle fait foi ; un compte supprimé laisse « invité par un compte supprimé »', async (t: TestContext) => {
  const app = makeApp();
  app.state.users = [
    { id: 1, username: 'Ben', role: 'admin', invitedBy: null, invitedByDeleted: false },
    { id: 2, username: 'Julie', role: 'membre', invitedBy: 'Ben', invitedByDeleted: false },
    { id: 3, username: 'Léa', role: 'membre', invitedBy: 'Julie', invitedByDeleted: false },
  ];
  const calls: ReturnType<typeof deferred<any>>[] = [];
  t.mock.method(api, 'setUserRole', () => { const d = deferred<any>(); calls.push(d); return d.promise; });
  app.setRole(2, 'parrain');
  app.setRole(2, 'membre');
  calls[1]!.resolve({ user: { id: 2, role: 'membre' } });
  await tick();
  calls[0]!.resolve({ user: { id: 2, role: 'parrain' } });
  await tick();
  assert.equal(app.state.users[1].role, 'membre');
  app.setRole(1, 'membre');                          // admin : aucun changement
  assert.equal(calls.length, 2);
  t.mock.method(api, 'deleteUser', async () => null);
  app.askDeleteUser(2);
  assert.equal(app.state.confirm.danger, true);
  app.state.confirm.action();
  await tick();
  assert.deepEqual(app.state.users.map((u: any) => u.id), [1, 3]);
  assert.equal(app.state.users[1].invitedByDeleted, true);
});

// Arbre de rendu (vnodes Preact) parcouru sans DOM.
type VNode = { type: unknown; props: Record<string, any> };
function nodes(v: unknown, out: VNode[] = []): VNode[] {
  if (Array.isArray(v)) { for (const c of v) nodes(c, out); return out; }
  if (!v || typeof v !== 'object') return out;
  const n = v as VNode;
  out.push(n);
  nodes(n.props?.children, out);
  return out;
}
const textOf = (v: unknown): string => (Array.isArray(v) ? v.map(textOf).join('')
  : v == null || typeof v === 'boolean' ? '' : typeof v === 'object' ? textOf((v as VNode).props?.children) : String(v));
/** Élément dont un enfant direct satisfait pred. */
const parentOf = (root: unknown, pred: (c: unknown) => boolean) => nodes(root).find((n) => [n.props?.children].flat(Infinity).some(pred));

test('Supprimer mon compte : seul un mot de passe refusé entoure le champ de rouge', async (t: TestContext) => {
  const V = await load('../public/app/views/account.js');
  const app = makeApp();
  app.state.me = { username: 'x', role: 'admin' };
  const del = t.mock.method(api, 'deleteMe', async () => { throw new ApiError(409, 'last_admin'); });
  // Cadre du champ : l'élément qui contient l'<input>.
  const borderOfField = () => String(parentOf(V.deleteSelfSheet(app, app.state.delSelf), (c) => !!c && (c as VNode).props?.id === 'mdp-suppr')?.props.style);
  app.askDeleteSelf();
  app.setDelSelf({ pw: 'bon-mot-de-passe' });
  app.confirmDeleteSelf();
  await tick();
  assert.equal(app.state.delSelf.error, 'Dernier compte admin : suppression impossible');
  assert.doesNotMatch(borderOfField(), /--danger/);
  del.mock.mockImplementation(async () => { throw new ApiError(403, 'wrong_password'); });
  app.confirmDeleteSelf();
  await tick();
  assert.match(borderOfField(), /--danger/);
  const input = nodes(V.deleteSelfSheet(app, app.state.delSelf)).find((n) => n.type === 'input' && n.props.id === 'mdp-suppr');
  input!.props.onInput({ currentTarget: { value: 'autre' } });   // nouvelle saisie : plus de rouge
  assert.equal(app.state.delSelf.pw, 'autre');
  assert.doesNotMatch(borderOfField(), /--danger/);
});

test('Comptes (admin) : un échec depuis la feuille de compte la ferme, sinon le toast serait caché dessous', async (t: TestContext) => {
  const app = makeApp();
  app.state.users = [{ id: 1, username: 'Ben', role: 'admin' }, { id: 2, username: 'Julie', role: 'membre' }];
  app.loadUsers = () => Promise.resolve(true);
  t.mock.method(api, 'resetLink', async () => { throw new ApiError(0, 'network'); });
  app.state.account = 2;
  app.createReset(2);
  await tick();
  assert.equal(app.state.account, null);
  assert.equal(app.state.resetBusy, false);
  t.mock.method(api, 'setUserRole', async () => { throw new ApiError(500, 'http_500'); });
  app.state.account = 2;
  app.setRole(2, 'parrain');
  await tick();
  assert.equal(app.state.account, null);
  assert.deepEqual(app.toasts.map((x: any) => x.text), ['Création impossible', 'Échec de l’enregistrement']);
});

test('Export : le titre de la feuille ne bouge pas à l’arrivée des données (sous-titre de hauteur fixe)', async () => {
  const V = await load('../public/app/views/account.js');
  const app = makeApp();
  const isPh = (c: unknown) => !!c && typeof c === 'object' && /ph-line/.test(String((c as VNode).props?.class));
  const loading = parentOf(V.exportSheetView(app, { data: null }), isPh);
  const sub = '3 épisodes vus · 1 série · JSON';
  const loaded = parentOf(V.exportSheetView(app, { data: { preview: '{}', sub, text: '{}', filename: 'f.json' } }), (c) => c === sub);
  assert.ok(loading && loaded);
  assert.match(String(loading.props.style), /(^|[;\s])height: \d+px/);
  assert.equal(loading.props.style, loaded.props.style);
});

test('Nouveau mot de passe : le nom du compte est dans le formulaire (gestionnaires de mots de passe)', async () => {
  const { viewAuth } = await load('../public/app/views/auth.js');
  const app = makeApp();
  const st = { ...app.state, auth: { screen: 'reset', token: 't', info: { username: 'Léa' } } };
  const user = nodes(viewAuth(app, st)).find((n) => n.type === 'input' && n.props.autocomplete === 'username');
  assert.equal(user?.props.value, 'Léa');
  assert.ok(user?.props.readonly);
  const pw = nodes(viewAuth(app, st)).find((n) => n.type === 'input' && n.props.autocomplete === 'new-password');
  assert.ok(pw);
});

test('Saisie : mêmes règles que le serveur (mot de passe en caractères, chiffres 0-9 seulement dans le nom)', async () => {
  const { viewAuth } = await load('../public/app/views/auth.js');
  assert.equal(A.passwordOk('😀'.repeat(5)), false);  // 5 caractères, 10 unités UTF-16
  assert.equal(A.passwordOk('😀'.repeat(10)), true);
  assert.equal(A.passwordOk('😀'.repeat(150)), true); // 150 caractères, 300 unités UTF-16
  assert.equal(A.passwordOk('😀'.repeat(201)), false);
  assert.equal(A.nameOk('Léo²_'), false);
  assert.equal(A.nameOk('Léo_2'), true);
  assert.equal(A.nameProblem('²'), A.NAME_RULE);
  const app = makeApp();
  const hint = (pw: string) => nodes(viewAuth(app, { ...app.state, auth: { screen: 'reset', token: 't', info: { username: 'x' } }, form: { ...app.state.form, pw } }))
    .find((n) => textOf(n).endsWith('caractères minimum') && n.type === 'span');
  assert.match(String(hint('😀'.repeat(5))?.props.style), /--faint/);
  assert.match(String(hint('😀'.repeat(10))?.props.style), /--ok/);
});

test('Droits retirés en cours d’utilisation (403 forbidden) : rôle relu, écran Parrainages quitté', async (t: TestContext) => {
  const app = makeApp();
  app.state.me = { username: 'Max', role: 'parrain' };
  app.state.tab = 'profil';
  app.state.stack = [{ type: 'invites', show: 0 }];
  const me = t.mock.method(api, 'me', async () => ({ username: 'Max', role: 'membre' }));
  t.mock.method(api, 'invites', async () => { throw new ApiError(403, 'forbidden'); });
  await app.loadInvites();
  await idle(app); await tick();
  assert.equal(me.mock.callCount(), 1);
  assert.equal(app.state.me.role, 'membre');
  assert.deepEqual(app.state.stack, []);
  assert.ok(!app.state.errs.invites);
  // Créer un lien depuis un écran resté ouvert : même chose, pas de « Création impossible ».
  app.state.me = { username: 'Max', role: 'parrain' };
  app.state.stack = [{ type: 'invites', show: 0 }];
  app.toasts.length = 0;
  t.mock.method(api, 'createInvite', async () => { throw new ApiError(403, 'forbidden'); });
  app.createInvite();
  await idle(app); await tick(); await tick();
  assert.deepEqual(app.state.stack, []);
  assert.equal(app.state.creatingInvite, false);
  assert.ok(!app.toasts.some((x: any) => x.text === 'Création impossible'));
});

test('notification touchée : cible lue (adresse ou message), fiche épisode ouverte une fois la session ouverte', async () => {
  const P = await load('../public/app/push.js');
  const target = { show: 12, name: 'Andor', season: 2, number: 3, ep: 45 };
  assert.deepEqual(P.notifTarget(new URLSearchParams('show=12&name=Andor&season=2&number=3&ep=45')), target);
  assert.deepEqual(P.notifTarget({ show: 12, name: 'Andor', season: 2, number: 3, ep: 45 }), target);
  assert.equal(P.notifTarget(new URLSearchParams('')), null);
  assert.equal(P.notifTarget(new URLSearchParams('show=12&season=2&number=3&ep=abc')), null);
  assert.equal(P.pushSupported(), false);   // Node : pas de service worker

  const app = makeApp();
  // Page de connexion affichée : gardée pour après la connexion.
  app.state.auth = { screen: 'login' };
  app.openNotified(target);
  assert.deepEqual(app.state.stack, []);
  assert.deepEqual(app.pendingOpen, target);
  app.state.auth = null;
  app.state.me = { username: 'Ben', role: 'membre' };
  app.state.picker = { title: 'x' };
  app.initPush = () => {};
  app.signedIn();
  assert.deepEqual(app.state.stack, [{ type: 'episode', show: 12, name: 'Andor', season: 2, number: 3, ep: 45 }]);
  assert.equal(app.state.picker, null);
  assert.equal(app.pendingOpen, null);
});
