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
