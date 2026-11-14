// @ts-check
// Composant racine : session (connexion, pages ouvertes par un lien), état de l'appli, chargements, écritures optimistes,
// navigation (onglets, explorateur, historique du navigateur), gestes (swipe, ressort « À venir ») et défilement de la
// timeline. Le rendu des écrans est dans views/.
import { html, Component } from '../vendor/htm-preact-3.1.1.js';
import { api, isAbort, onUnauthorized } from './api.js';
import { THEMES, compareEp, dayOf, fShort, inDays, localDay, plural } from './format.js';
import { authErrorField, authErrorText, canInvite, cleanName, parseAuthRoute } from './auth.js';
import * as S from './store.js';
import * as P from './push.js';
import { I } from './icons.js';
import { confirmSheet, pickerSheet } from './components.js';
import { viewEncours } from './views/encours.js';
import { viewDecote } from './views/decote.js';
import { viewSeries } from './views/series.js';
import { viewProfil } from './views/profil.js';
import { viewShow } from './views/show.js';
import { viewSeason } from './views/season.js';
import { viewEpisode } from './views/episode.js';
import { viewAuth } from './views/auth.js';
import { accountSheet, deleteSelfSheet, exportSheetView, linkSheetView, viewAdmin, viewInvites } from './views/account.js';
import { viewImport } from './views/import.js';
import { viewAbout } from './views/about.js';

/** Glissement à dépasser pour valider un swipe (px). */
export const THRESHOLD = 110;
/** Tirage à dépasser pour ouvrir « À venir » (px). */
export const PULL_OPEN = 130;
/** Distance au haut de la timeline à partir de laquelle on charge la page d'historique précédente (px). */
const HISTORY_PREFETCH = 900;
const SEARCH_DEBOUNCE = 300;
const FALLBACK_TZ = 'Europe/Paris';

function loadTheme() {
  try {
    const t = localStorage.getItem('theme');
    if (THEMES.some((x) => x.v === t)) return /** @type {string} */ (t);
  } catch { /* stockage indisponible : thème Système */ }
  return 'system';
}

/** Vue empilée : explorateur (show = id de série) ou écran de compte ouvert depuis Profil (show = 0).
 * @typedef {{ type: 'show' | 'season' | 'episode' | 'invites' | 'admin' | 'import' | 'about', show: number, name?: string, season?: number, number?: number, ep?: number }} View */

/** @param {View} v */
const viewKey = (v) => v.type + ':' + v.show + ':' + (v.season ?? '') + ':' + (v.ep ?? '');

/**
 * Écriture en file : appliquée tout de suite à l'écran (apply), envoyée ensuite (request), recalée sur la réponse.
 * @typedef {{
 *   key: string | number,
 *   apply: (s: any) => { patch: Record<string, any>, histAdded?: number[], histRemoved?: any[] },
 *   revert?: (s: any) => Record<string, any>,
 *   request: () => Promise<any>,
 *   onResult?: (res: any) => void,
 *   resync?: boolean,
 *   snap?: any, histAdded?: number[], histRemoved?: any[], result?: any,
 * }} Op
 */

/**
 * Page hors appli. info : réponse de la lecture du lien (invitation, réinitialisation).
 * @typedef {{ screen: 'login' | 'signup' | 'reset' | 'invalid', code?: string, token?: string, info?: any, infoFailed?: boolean }} Auth
 * @typedef {{ name: string, pw: string, show: boolean, busy: boolean, error: string | null, bad: 'name' | 'password' | null, wait?: boolean }} Form
 * Feuille « Supprimer mon compte » ; bad : champ refusé par le serveur (seul le mot de passe peut l'être).
 * @typedef {Omit<Form, 'name'>} DelSelf
 * Page d'import : fichiers lus, séries proposées (analysis), choix de l'utilisateur, recherche d'une autre série, résultat.
 * @typedef {{
 *   files: { name: string, text: string }[] | null, step: 'pick' | 'reading' | 'analyzing' | 'review' | 'importing' | 'done',
 *   analysis: any, choices: Record<string, number | null>, extra: Record<string, any[]>, showSure: boolean,
 *   searchFor: string | null, searchQ: string, searchResults: any[] | null, report: any, error: string | null,
 * }} ImportState
 */

/**
 * @typedef {{
 *   tab: string, stack: View[], drag: any, toast: { text: string, undo: (() => void) | null } | null,
 *   picker: any, confirm: any, upcomingOpen: boolean, theme: string,
 *   me: any, countries: string[] | null, today: string | null, tl: any, hist: any, shelf: any, mine: any,
 *   search: { q: string, results: any[] | null, loading: boolean, error: boolean },
 *   shows: Record<number, any>, seasons: Record<string, any>, errs: Record<string, boolean>,
 *   auth: Auth | null, form: Form,
 *   invites: any[] | null, users: any[] | null, creatingInvite: boolean, resetBusy: boolean,
 *   linkSheet: { title: string, sub: string, url: string | null, inviteId?: number, copied?: 'ok' | 'fail' | null } | null,
 *   account: number | null, exportSheet: { data: any } | null,
 *   delSelf: DelSelf | null, imp: ImportState,
 *   push: import('./push.js').PushState | null, pushBusy: boolean, about: any,
 * }} State
 */

/** Message d'échec d'un import. @param {any} e */
function importErrorText(e) {
  if (e && e.code === 'import_format') {
    const bad = (e.files || []).filter((/** @type {any} */ f) => f.error).map((/** @type {any} */ f) => f.name);
    return 'Fichier non reconnu : ' + bad.join(', ');
  }
  if (e && e.code === 'import_busy') return 'Un import est déjà en cours';
  if (e && e.code === 'payload_too_large') return 'Fichiers trop volumineux';
  if (e && e.code === 'network') return 'Serveur injoignable';
  return 'Import impossible';
}

/** @returns {ImportState} */
const emptyImport = () => ({ files: null, step: 'pick', analysis: null, choices: {}, extra: {}, showSure: false, searchFor: null, searchQ: '', searchResults: null, report: null, error: null });

/** @returns {Form} */
const emptyForm = () => ({ name: '', pw: '', show: false, busy: false, error: null, bad: null });

/** Feuilles et confirmations affichées par-dessus l'écran : toutes fermées. */
const NO_OVERLAY = { picker: null, confirm: null, linkSheet: null, account: null, exportSheet: null, delSelf: null };
/** @param {State} s */
const hasOverlay = (s) => Object.keys(NO_OVERLAY).some((k) => /** @type {any} */ (s)[k] != null);

/** État d'une session neuve (démarrage, connexion, déconnexion) : rien du compte précédent ne reste. @param {string} theme @returns {State} */
function initialState(theme) {
  return {
    tab: 'encours', stack: [], drag: null, toast: null, picker: null, confirm: null, upcomingOpen: false,
    theme,
    me: null, countries: null, today: null,
    tl: null, hist: null, shelf: null, mine: null,
    search: { q: '', results: null, loading: false, error: false },
    shows: {}, seasons: {},
    errs: {},
    auth: null, form: emptyForm(),
    invites: null, users: null, creatingInvite: false, resetBusy: false,
    linkSheet: null, account: null, exportSheet: null, delSelf: null, imp: emptyImport(),
    push: null, pushBusy: false, about: null,
  };
}

/** @extends {Component<any, State>} */
export class App extends Component {
  /** @param {any} props */
  constructor(props) {
    super(props);
    /** @type {HTMLElement | null} */
    this.scroller = null;
    /** @type {HTMLElement | null} */
    this.content = null;
    /** @type {HTMLElement | null} */
    this.handle = null;
    /** @type {HTMLElement | null} */
    this.peekEl = null;
    /** @type {HTMLElement | null} */
    this.peekInner = null;
    /** @type {string | null} vue de la pile dont les données ont été demandées */
    this.ensuredKey = null;
    /** @type {string | null} */
    this.lastView = null;
    /** @type {View | undefined} */
    this.lastTop = undefined;
    this.lastTab = '';
    this.lastDepth = 0;
    this.viewAnim = '';
    /** @type {State} */
    this.state = initialState(loadTheme());
    // Session courante : une réponse arrivée après une connexion ou une déconnexion est jetée (voir read, pump).
    this.epoch = 0;
    /** @type {number | null} session close par signedOut (les 401 suivants de la même session sont ignorés) */
    this.signedOutEpoch = null;
    this.authSeq = 0;
    this.loggingOut = false;
    this.revoking = false;
    /** @type {Record<number, number>} dernier choix de rôle envoyé, par compte */
    this.roleSeq = {};
    /** @type {Op[]} */
    this.queue = [];
    this.running = false;
    // Compteur d'écritures : une lecture partie avant une écriture est relancée après (voir read).
    this.writeSeq = 0;
    /** @type {(() => void)[]} lectures à relancer quand la file d'écritures sera vide */
    this.waiting = [];
    /** @type {Record<string, number>} écritures en attente par série */
    this.pending = {};
    /** @type {Set<string | number>} séries à relire dès que leurs écritures en attente sont terminées (voir settle) */
    this.needResync = new Set();
    // Incrémenté à chaque remplacement de l'historique : une page plus ancienne demandée avant est ignorée.
    this.histGen = 0;
    /** @type {Map<string, number>} position de défilement des écrans recouverts par une vue de l'explorateur */
    this.scrollMemo = new Map();
    /** @type {string | null} écran qui réapparaît et dont la position est à rétablir */
    this.pendingRestore = null;
    this.searchTerm = '';
    // Une action depuis l'entrée dans l'onglet : les données rechargées ne réordonnent plus la liste.
    this.touched = false;
    this.searchSeq = 0;
    this.importSearchSeq = 0;
    /** @type {AbortController | null} */
    this.searchCtl = null;
    /** @type {Map<string, Promise<boolean>>} chargements en cours (fiche, saison), pour ne pas les dupliquer */
    this.inflight = new Map();
    // Avec les transitions d'écran, l'ancienne vue peut être démontée après le montage de la nouvelle : ne pas écraser la nouvelle référence.
    this.setScroller = (/** @type {HTMLElement | null} */ el) => { if (el || (this.scroller && !this.scroller.isConnected)) this.scroller = el; };
    this.setContent = (/** @type {HTMLElement | null} */ el) => { this.content = el; };
    /** @type {HTMLElement | null} */
    this.mainEl = null;
    this.setMain = (/** @type {HTMLElement | null} */ el) => { this.mainEl = el; };
    this.setHandle = (/** @type {HTMLElement | null} */ el) => { this.handle = el; };
    this.setPeek = (/** @type {HTMLElement | null} */ el) => { this.peekEl = el; };
    this.setPeekInner = (/** @type {HTMLElement | null} */ el) => { this.peekInner = el; };
    this.onScroll = () => this.handleScroll();
    this.onTouchStart = () => { this.pullOrigin = null; };
    this.onTouchMove = (/** @type {TouchEvent} */ ev) => { if (ev.touches && ev.touches[0]) this.pullMove(ev.touches[0].clientY); };
    this.onTouchEnd = () => this.pullEnd();
    this.onWheel = (/** @type {WheelEvent} */ ev) => this.handleWheel(ev);
    this.onPop = (/** @type {PopStateEvent} */ ev) => this.handlePop(ev);
    // Notification touchée alors que l'appli est ouverte : le service worker transmet la cible.
    this.onWorkerMessage = (/** @type {MessageEvent} */ ev) => {
      const t = ev.data && ev.data.type === 'open-episode' ? P.notifTarget(ev.data.open || {}) : null;
      if (t) this.openNotified(t);
    };
    /** @type {ReturnType<typeof P.notifTarget>} épisode à ouvrir dès la session ouverte (notification touchée) */
    this.pendingOpen = null;
    this.onSearchInput = (/** @type {Event} */ ev) => this.searchInput(/** @type {HTMLInputElement} */ (ev.currentTarget).value);
    /** L'entrée d'historique de la feuille ouverte est en place. */
    this.sheetEntry = false;
    this.closePicker = () => this.setState({ picker: null });
    this.closeConfirm = () => this.setState({ confirm: null });
  }

  // ---------- thème ----------
  // 'system' suit le réglage du téléphone, y compris s'il change pendant l'utilisation.
  /** @param {string} t */
  applyTheme(t) {
    const dark = t === 'dark' || (t === 'system' && !(this.mqLight && this.mqLight.matches));
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  /** @param {string} t */
  setTheme(t) {
    try { localStorage.setItem('theme', t); } catch { /* réglage gardé pour la session seulement */ }
    this.applyTheme(t);
    this.setState({ theme: t });
  }

  componentDidMount() {
    // Ouvert par une notification (/?show=…&ep=…) : l'épisode s'ouvrira par-dessus la timeline, l'adresse redevient '/'.
    this.pendingOpen = P.notifTarget(new URLSearchParams(location.search));
    if (this.pendingOpen) { try { history.replaceState(history.state, '', '/'); } catch { /* adresse inchangée */ } }
    if (P.pushSupported()) navigator.serviceWorker.addEventListener('message', this.onWorkerMessage);
    this.mqLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    if (this.mqLight) this.mqLight.addEventListener('change', () => { if (this.state.theme === 'system') this.applyTheme('system'); });
    this.applyTheme(this.state.theme);
    // Chaque vue ouverte dans l'explorateur = une entrée d'historique : le retour système (Android, geste)
    // fait la même chose que la flèche « retour » de l'appli.
    // Rechargé depuis une vue de l'explorateur : la pile repart vide, on revient d'abord à l'entrée de base (nav 0).
    // Une feuille ouverte a aussi son entrée ({ nav, sheet: true }) : le retour système la ferme.
    try {
      const nav = history.state && typeof history.state.nav === 'number' ? history.state.nav + (history.state.sheet ? 1 : 0) : 0;
      if (nav > 0) history.go(-nav);
      else history.replaceState({ nav: 0 }, '');
      this.useHistory = true;
    } catch { this.useHistory = false; }
    window.addEventListener('popstate', this.onPop);
    // Session expirée ou supprimée en cours d'utilisation : retour à la connexion.
    onUnauthorized(() => this.signedOut());
    const route = parseAuthRoute(location.pathname);
    if (route) { this.openAuthRoute(route); return; }
    // Sans session, /api/me et la timeline répondent 401 : la connexion s'affiche.
    this.pendingScroll = 'anchor';
    this.loadMe().then((ok) => { if (ok && this.state.me) this.signedIn(); });
    this.loadTab('encours');
  }

  componentWillUnmount() {
    window.removeEventListener('popstate', this.onPop);
    if (P.pushSupported()) navigator.serviceWorker.removeEventListener('message', this.onWorkerMessage);
    onUnauthorized(null);
  }

  componentDidUpdate() {
    // Timeline démontée (changement d'onglet) : sa référence ne doit plus servir au placement.
    if (this.scroller && !this.scroller.isConnected) this.scroller = null;
    this.restoreScroll();
    if (this.pendingOpenShift != null && this.scroller) {
      const shift = this.pendingOpenShift;
      this.setPull(0, false);
      this.scroller.scrollTop += shift;
      this.pendingOpenShift = null;
    }
    this.keepAnchor();
    this.placeScroll();
    this.maybeLoadOlder();
    this.ensureTop();
    this.syncSheetEntry();
  }

  /** Feuille ouverte → une entrée d'historique ; fermée par l'appli (fond, glissement, choix) → l'entrée est retirée. */
  syncSheetEntry() {
    if (!this.useHistory) return;
    const open = hasOverlay(this.state);
    if (open && !this.sheetEntry) {
      try { history.pushState({ nav: this.state.stack.length, sheet: true }, ''); this.sheetEntry = true; } catch { /* retour système sans effet sur la feuille */ }
    } else if (!open && this.sheetEntry) {
      this.sheetEntry = false;
      history.back();
    }
  }

  /** Entrées d'historique au-dessus de l'entrée de base (vues de l'explorateur + feuille), à retirer d'un coup. */
  dropHistoryEntries() {
    const n = this.state.stack.length + (this.sheetEntry ? 1 : 0);
    this.sheetEntry = false;
    if (this.useHistory && n) history.go(-n);
  }

  // ---------- utilitaires d'état ----------
  /** Jour courant : celui du serveur (fuseau de l'utilisateur) ; à défaut, l'horloge dans ce fuseau. */
  today() {
    return this.state.today || localDay(new Date().toISOString(), this.tz());
  }
  tz() { return (this.state.me && this.state.me.timezone) || FALLBACK_TZ; }
  /** @param {string} key @param {boolean} on */
  setErr(key, on) { this.setState((/** @type {any} */ s) => (!!s.errs[key] === on ? null : { errs: { ...s.errs, [key]: on } })); }

  /** Nom et affiche d'une série, depuis ce qui est en mémoire. @param {any} s @param {number} id @param {string} [name] */
  showRefOf(s, id, name) {
    const d = s.shows[id];
    if (d && d.name) return { id, name: d.name, posterPath: d.posterPath ?? null };
    const e = (s.tl && s.tl.entries[id]) || (s.shelf && s.shelf.cards[id]);
    if (e) return e.show;
    const row = (s.mine && s.mine.rows.find((/** @type {any} */ r) => r.id === id)) || (s.search.results && s.search.results.find((/** @type {any} */ r) => r.id === id));
    if (row) return { id, name: row.name, posterPath: row.posterPath };
    const h = s.hist && s.hist.items.find((/** @type {any} */ x) => x.show.id === id);
    if (h) return h.show;
    return { id, name: name || '', posterPath: null };
  }

  // ---------- chargements ----------
  /** @param {string} t */
  loadTab(t) {
    if (t === 'encours') this.loadTimeline();
    else if (t === 'decote') this.loadShelf();
    else if (t === 'series') this.loadMine();
    else if (t === 'profil') {
      this.loadMine();
      // Pays JustWatch : chargés une fois par session ; en échec, la ligne Pays reste inactive jusqu'à la visite suivante.
      if (!this.state.countries) this.read(() => api.countries(), (r) => this.setState({ countries: r.countries }), () => {});
      // Le rôle décide des lignes Parrainages / Comptes et de leurs compteurs.
      this.loadMe().then((ok) => {
        const me = this.state.me;
        if (!ok || !me || this.state.tab !== 'profil') return;
        if (canInvite(me.role)) this.loadInvites();
        if (me.role === 'admin') this.loadUsers();
      });
    }
  }

  loadMe() {
    this.setErr('me', false);
    return this.read(() => api.me(), (me) => this.setState({ me }), () => { if (!this.state.me) this.setErr('me', true); });
  }

  loadTimeline() {
    this.setErr('tl', false);
    this.read(() => Promise.all([api.timeline(), api.history(null)]), ([tl, h]) => {
      this.captureAnchor();
      this.histGen++;
      this.setState((/** @type {any} */ s) => ({
        today: tl.today,
        tl: S.timelineFrom(s.tl, tl, !this.touched || !s.tl),
        hist: { items: h.items, next: h.next, loading: false, failed: false },
      }));
    }, () => { if (!this.state.tl) this.setErr('tl', true); });
  }

  loadShelf() {
    this.setErr('shelf', false);
    this.read(() => api.shelf(), (data) => this.setState((/** @type {any} */ s) => ({ shelf: S.shelfFrom(s.shelf, data, !this.touched || !s.shelf) })),
      () => { if (!this.state.shelf) this.setErr('shelf', true); });
  }

  loadMine() {
    this.setErr('mine', false);
    this.read(() => api.myShows(), (data) => this.setState({ mine: { rows: data.shows } }),
      () => { if (!this.state.mine) this.setErr('mine', true); });
  }

  /** Fiche série ; silencieux si déjà en cache. @param {number} id */
  loadShow(id) {
    const k = 'show:' + id;
    return this.once(k, () => this.read(() => api.show(id), (d) => this.setState((/** @type {any} */ s) => ({ shows: { ...s.shows, [id]: d } })),
      () => { if (!this.state.shows[id]) this.setErr(k, true); }));
  }

  /** Saison (épisodes + de quoi afficher la fiche épisode). @param {number} id @param {number} n */
  loadSeason(id, n) {
    const k = 'season:' + id + ':' + n;
    return this.once(k, () => this.read(() => api.season(id, n), (data) => this.setState((/** @type {any} */ s) => ({ seasons: { ...s.seasons, [id + ':' + n]: S.seasonEntry(data) } })),
      () => { if (!this.state.seasons[id + ':' + n]) this.setErr(k, true); }));
  }

  /**
   * Lecture qui doit refléter toutes les écritures : si une écriture a eu lieu pendant la requête, la réponse peut être
   * antérieure à l'affichage optimiste ; elle est jetée et la lecture relancée une fois la file d'écritures vide.
   * Résout true une fois les données appliquées (relance comprise), false en cas d'échec.
   * @template T
   * @param {() => Promise<T>} request @param {(data: T) => void} apply @param {(e: any) => void} onError
   * @returns {Promise<boolean>}
   */
  read(request, apply, onError) {
    const seq0 = this.writeSeq;
    const busy0 = this.queue.length > 0;
    const epoch = this.epoch;
    return request().then((data) => {
      if (epoch !== this.epoch) return false;
      if (busy0 || this.writeSeq !== seq0 || this.queue.length) {
        return new Promise((resolve) => this.afterWrites(() => resolve(this.read(request, apply, onError))));
      }
      apply(data);
      return true;
    }, (e) => { if (epoch === this.epoch) onError(e); return false; });
  }

  /** @param {() => void} fn */
  afterWrites(fn) {
    this.waiting.push(fn);
    if (!this.running) setTimeout(() => this.flushWaiting(), 0);
  }
  flushWaiting() {
    if (this.running || this.queue.length) return;
    const fns = this.waiting.splice(0);
    fns.forEach((f) => f());
  }

  /** Un seul chargement à la fois par clé ; l'erreur précédente est effacée. @param {string} k @param {() => Promise<boolean>} load */
  once(k, load) {
    const cur = this.inflight.get(k);
    if (cur) return cur;
    this.setErr(k, false);
    const p = load().finally(() => { if (this.inflight.get(k) === p) this.inflight.delete(k); });
    this.inflight.set(k, p);
    return p;
  }

  /** Saison voisine pour « épisode précédent / suivant » (appelé au rendu : différé). @param {number} id @param {number} n */
  prefetchSeason(id, n) {
    if (this.state.seasons[id + ':' + n] || this.inflight.has('season:' + id + ':' + n)) return;
    setTimeout(() => this.loadSeason(id, n), 0);
  }

  /** Données de la vue du haut de la pile, chargées (ou rafraîchies sans bruit) à son ouverture. */
  ensureTop() {
    const top = this.state.stack[this.state.stack.length - 1];
    const key = top ? viewKey(top) : null;
    if (key === this.ensuredKey) return;
    this.ensuredKey = key;
    if (!top) return;
    if (top.type === 'import') return;
    if (top.type === 'about') this.loadAbout();
    else if (top.type === 'invites') this.loadInvites();
    else if (top.type === 'admin') this.loadUsers();
    else if (top.type === 'show') this.loadShow(top.show);
    else {
      this.loadSeason(top.show, /** @type {number} */ (top.season));
      if (top.type === 'episode') this.loadShow(top.show);
    }
  }

  // Page d'historique plus ancienne, quand on approche du haut de la timeline.
  maybeLoadOlder() {
    const st = this.state;
    const h = st.hist;
    if (st.tab !== 'encours' || st.stack.length || !this.scroller || !h || !h.next || h.loading || h.failed) return;
    if (this.scroller.scrollTop > HISTORY_PREFETCH) return;
    const cursor = h.next;
    // Une page partie avant un rechargement de l'historique ne s'y raccroche pas (son curseur n'est plus le bon).
    const gen = this.histGen;
    this.setState((/** @type {any} */ s) => ({ hist: { ...s.hist, loading: true } }));
    api.history(cursor).then((page) => {
      if (gen !== this.histGen) return;
      this.captureAnchor();
      this.setState((/** @type {any} */ s) => ({ hist: { ...s.hist, items: S.addHistory(s.hist.items, page.items), next: page.next, loading: false } }));
    }, () => { if (gen === this.histGen) this.setState((/** @type {any} */ s) => ({ hist: { ...s.hist, loading: false, failed: true } })); });
  }

  /** Après une écriture par lot : saisons, fiche et historique récents relus (épisodes pas encore chargés). @param {number} id */
  resyncShow(id) {
    if (this.pending[id]) return;
    const st = this.state;
    if (st.shows[id]) this.loadShow(id);
    const prefix = id + ':';
    Object.keys(st.seasons).filter((k) => k.startsWith(prefix)).forEach((k) => this.loadSeason(id, Number(k.slice(prefix.length))));
    if (st.hist) this.reloadHistory();
  }

  // Les épisodes d'un lot ont des dates plus récentes que tout ce qui est chargé, et peuvent dépasser une page :
  // l'historique repart de la première page et de son curseur (les pages plus anciennes se rechargent en remontant).
  reloadHistory() {
    this.read(() => api.history(null), (page) => {
      this.captureAnchor();
      this.histGen++;
      this.setState({ hist: { items: page.items, next: page.next, loading: false, failed: false } });
    }, () => {});
  }

  /** Une série dont une écriture par lot vient d'aboutir est relue quand plus rien n'est en attente pour elle. @param {string | number} key */
  settle(key) {
    if (this.pending[key] || !this.needResync.has(key)) return;
    this.needResync.delete(key);
    if (typeof key === 'number') this.resyncShow(key);
  }

  // ---------- écritures ----------
  /** @param {Op} op */
  run(op) {
    this.touched = true;
    this.captureAnchor();
    this.setState((/** @type {any} */ s) => {
      op.snap = typeof op.key === 'number' ? S.snapshot(s, op.key) : null;
      const r = op.apply(s);
      op.histAdded = r.histAdded || [];
      op.histRemoved = r.histRemoved || [];
      return r.patch;
    });
    this.writeSeq++;
    this.queue.push(op);
    this.pending[op.key] = (this.pending[op.key] || 0) + 1;
    this.pump();
    return op;
  }

  // Une écriture à la fois, dans l'ordre : l'état renvoyé par le serveur n'est appliqué que si plus rien n'est en attente
  // pour cette série (sinon il écraserait les actions suivantes, déjà affichées).
  async pump() {
    if (this.running) return;
    this.running = true;
    let epoch = this.epoch;
    while (this.queue.length) {
      const op = this.queue[0];
      let res, ok = true;
      try {
        res = await op.request();
      } catch {
        ok = false;
      }
      // Session changée pendant la requête : la file a été vidée, cette écriture ne concerne plus l'écran.
      if (epoch !== this.epoch) { epoch = this.epoch; continue; }
      if (!ok) {
        this.fail();
        continue;
      }
      this.queue.shift();
      this.pending[op.key]--;
      op.result = res;
      if (op.resync) this.needResync.add(op.key);
      if (op.onResult) op.onResult(res);
      if (this.pending[op.key] || !res) { this.settle(op.key); continue; }
      const states = res.shows || (res.show ? [res.show] : []);
      let needUpNext = false;
      if (states.length) {
        this.captureAnchor();
        this.setState((/** @type {any} */ s) => {
          const acc = { ...s };
          /** @type {Record<string, any>} */
          const merged = {};
          for (const st of states) {
            const r = S.applyShowState(acc, st);
            Object.assign(acc, r.patch);
            Object.assign(merged, r.patch);
            needUpNext = needUpNext || r.needUpNext;
          }
          return merged;
        });
      }
      if (needUpNext) this.refreshUpNext();
      this.settle(op.key);
    }
    this.running = false;
    this.flushWaiting();
  }

  // Échec : cette écriture et toutes celles qui attendaient derrière sont défaites, de la plus récente à la plus ancienne.
  fail() {
    const failed = this.queue.splice(0);
    for (const o of failed) this.pending[o.key]--;
    this.captureAnchor();
    this.setState((/** @type {any} */ s) => {
      const acc = { ...s };
      /** @type {Record<string, any>} */
      const merged = {};
      for (const o of [...failed].reverse()) {
        const p = o.revert ? o.revert(acc) : S.restore(acc, /** @type {number} */ (o.key), o.snap, o.histAdded || [], o.histRemoved || []);
        Object.assign(acc, p);
        Object.assign(merged, p);
      }
      return { ...merged, confirm: null };
    });
    // Un lot déjà enregistré avant l'échec reste à relire.
    for (const k of [...this.needResync]) this.settle(k);
    this.toast('Échec de l’enregistrement');
  }

  refreshUpNext() {
    this.read(() => api.timeline(), (data) => this.setState((/** @type {any} */ s) => (s.tl ? { tl: S.mergeUpNext(s.tl, data), today: data.today } : null)),
      () => {});
  }

  /** @param {string} text @param {(() => void) | null} [undo] */
  toast(text, undo) {
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.setState({ toast: null }), undo ? 5000 : 3000);
    this.setState({ toast: { text, undo: undo || null } });
  }

  /** Annuler : remet l'écran comme avant l'action, puis envoie l'opération inverse (construite avec la réponse de l'action).
   * @param {Op} action @param {(res: any) => Promise<any> | null} inverse */
  undo(action, inverse) {
    clearTimeout(this.toastTimer);
    this.setState({ toast: null });
    const id = /** @type {number} */ (action.key);
    this.run({
      key: id,
      apply: (s) => {
        const addedItems = s.hist ? s.hist.items.filter((/** @type {any} */ x) => (action.histAdded || []).includes(x.episodeId)) : [];
        return {
          patch: S.restore(s, id, action.snap, action.histAdded || [], action.histRemoved || []),
          histAdded: (action.histRemoved || []).map((/** @type {any} */ x) => x.episodeId),
          histRemoved: addedItems,
        };
      },
      request: () => inverse(action.result) || Promise.resolve(null),
      // L'instantané ne couvre pas ce qui a été chargé après l'action (une saison ouverte entre-temps) : relecture.
      resync: true,
    });
  }

  /** @param {S.Change} ch @param {() => Promise<any>} request @param {string} text @param {(res: any) => Promise<any> | null} inverse @param {boolean} [resync] */
  change(ch, request, text, inverse, resync) {
    const op = this.run({ key: ch.showId, apply: (s) => S.applyChange(s, ch), request, resync });
    this.setState({ confirm: null });
    this.toast(text, () => this.undo(op, inverse));
  }

  /** Base d'un changement : série, instant et jour. @param {number} showId */
  changeBase(showId) {
    return { showId, at: new Date().toISOString(), day: this.today(), show: this.showRefOf(this.state, showId) };
  }

  /** Marquer vu un épisode sorti. @param {number} showId @param {any} ep @param {string} text */
  markEp(showId, ep, text) {
    const e = S.epOf(ep);
    // Déjà vu côté serveur (écran périmé) : rien n'a été marqué, Annuler ne doit pas effacer ce visionnage.
    this.change({ ...this.changeBase(showId), on: true, eps: [e], count: 1 }, () => api.mark(e.id), text,
      (res) => (res && res.marked.length ? api.unmark(e.id) : null));
  }

  /** Remettre non vu. @param {number} showId @param {any} ep @param {string} text */
  unmarkEp(showId, ep, text) {
    const e = S.epOf(ep);
    this.change({ ...this.changeBase(showId), on: false, eps: [e], count: 1 }, () => api.unmark(e.id), text,
      (res) => (res && res.removed.length ? api.mark(e.id, res.removed[0].watchedAt) : null));
  }

  /** @param {number} showId @param {any} ep @param {boolean} watched */
  toggleEp(showId, ep, watched) {
    const label = this.showRefOf(this.state, showId).name + ' S' + ep.season + 'E' + ep.number;
    if (watched) this.unmarkEp(showId, ep, label + ' remis en non vu');
    else this.markEp(showId, ep, label + ' vu');
  }

  /** Épisodes connus (saisons en cache) d'une série, triés. @param {number} showId */
  knownEpisodes(showId) {
    const prefix = showId + ':';
    /** @type {any[]} */
    const out = [];
    for (const [k, sc] of Object.entries(this.state.seasons)) if (k.startsWith(prefix)) out.push(...sc.data.episodes);
    return out.sort(compareEp);
  }

  /** « Tout marquer vu jusqu'ici ». @param {number} showId @param {any} target @param {number} count */
  markUntil(showId, target, count) {
    const eps = this.knownEpisodes(showId).filter((e) => e.aired && !e.watchedAt && compareEp(e, target) <= 0).map(S.epOf);
    this.change({ ...this.changeBase(showId), on: true, eps, count, upTo: S.epOf(target) },
      () => api.watchedUntil(showId, target.id),
      plural(count, 'épisode', 'épisodes') + ' de ' + this.showRefOf(this.state, showId).name + (count > 1 ? ' marqués vus' : ' marqué vu'),
      (res) => (res && res.marked.length ? api.batch({ on: false, episodeIds: res.marked }) : null), true);
  }

  /** Coche de saison, avec confirmation. @param {number} showId @param {number} n */
  askSeason(showId, n) {
    const st = this.state;
    const sc = st.seasons[showId + ':' + n];
    const se = st.shows[showId] && st.shows[showId].seasons ? st.shows[showId].seasons.find((/** @type {any} */ x) => x.number === n) : null;
    let aired, seen, missingEps = null, seenEps = null;
    if (sc) {
      const eps = sc.data.episodes;
      aired = eps.filter((/** @type {any} */ e) => e.aired).length;
      missingEps = eps.filter((/** @type {any} */ e) => e.aired && !e.watchedAt);
      seenEps = eps.filter((/** @type {any} */ e) => e.watchedAt);
      seen = seenEps.length;
    } else if (se) {
      aired = se.aired;
      seen = se.seen;
    } else return;
    if (!aired) return;
    const complete = sc ? /** @type {any[]} */ (missingEps).length === 0 : seen >= aired;
    const who = this.showRefOf(st, showId).name + ', saison ' + n;
    if (complete) {
      // La liste des épisodes vus est nécessaire pour les remettre non vus : saison chargée d'abord.
      if (!sc) {
        this.loadSeason(showId, n).then((ok) => {
          if (!ok) { this.toast('Chargement impossible'); return; }
          // setTimeout : l'état n'est à jour qu'après le rendu déclenché par le chargement.
          setTimeout(() => { if (this.state.seasons[showId + ':' + n]) this.askSeason(showId, n); }, 0);
        });
        return;
      }
      const list = /** @type {any[]} */ (seenEps);
      this.setState({ confirm: {
        title: 'Saison ' + n + ' non vue ?',
        text: who + ' : ' + plural(list.length, 'épisode vu sera remis', 'épisodes vus seront remis') + ' en non vu.',
        ok: 'Marquer la saison non vue',
        action: () => this.change({ ...this.changeBase(showId), on: false, eps: list.map(S.epOf), count: list.length },
          () => api.batch({ on: false, episodeIds: list.map((e) => e.id) }), who + ' remise en non vue',
          (res) => (res && res.removed.length ? api.batch({ on: true, restore: res.removed }) : null), true),
      } });
    } else {
      const known = missingEps ? missingEps.map(S.epOf) : [];
      const count = missingEps ? missingEps.length : Math.max(0, aired - seen);
      this.setState({ confirm: {
        title: 'Toute la saison ' + n + ' vue ?',
        text: who + ' : ' + plural(count, 'épisode diffusé sera marqué vu', 'épisodes diffusés seront marqués vus') + '.',
        ok: 'Marquer la saison vue',
        action: () => this.change({ ...this.changeBase(showId), on: true, eps: known, count, seasonsAll: [n] },
          () => api.markSeason(showId, n), who + ' marquée vue',
          (res) => (res && res.marked.length ? api.batch({ on: false, episodeIds: res.marked }) : null), true),
      } });
    }
  }

  /** Suivi d'une série : Non suivie / En cours / De côté. Ne touche jamais aux épisodes vus. @param {number} id @param {'none' | 'on' | 'shelf'} to */
  setRelation(id, to) {
    this.run({
      key: id,
      apply: (s) => ({ patch: S.applyRelation(s, id, to) }),
      request: () => api.setRelation(id, to),
      onResult: () => { if (this.state.mine) this.loadMine(); },
    });
  }

  /** Réglages du compte (Profil). @param {Record<string, any>} patch */
  patchMe(patch) {
    const before = this.state.me;
    if (!before) return;
    this.run({
      key: 'me',
      apply: (s) => ({ patch: { me: { ...s.me, ...patch } } }),
      revert: () => ({ me: before }),
      request: () => api.patchMe(patch),
      onResult: (me) => {
        // Un autre réglage encore en attente : son affichage optimiste reste, le dernier retour fera foi.
        if (!this.pending.me) this.setState({ me });
        // Pays changé : les plateformes en cache ne sont plus les bonnes.
        if (patch.country) this.setState({ shows: {}, seasons: {} });
      },
    });
  }

  // ---------- session ----------
  /**
   * Repart d'un état neuf (rien du compte précédent ne reste à l'écran ni en mémoire) ; auth = page hors appli à afficher.
   * Les requêtes encore en vol sont ignorées à leur retour (epoch).
   * @param {Auth | null} auth
   */
  resetSession(auth) {
    this.epoch++;
    this.queue = [];
    this.pending = {};
    this.waiting = [];
    this.needResync.clear();
    this.inflight.clear();
    this.scrollMemo.clear();
    this.pendingRestore = null;
    this.ensuredKey = null;
    this.anchorKeep = null;
    this.pendingOpenShift = null;
    this.touched = false;
    this.histGen++;
    this.searchSeq++;
    this.searchTerm = '';
    if (this.searchCtl) this.searchCtl.abort();
    clearTimeout(this.searchTimer);
    clearTimeout(this.toastTimer);
    this.g = null;
    this.loggingOut = false;
    this.revoking = false;
    // Vues de l'explorateur et feuille ouvertes : leurs entrées d'historique sont retirées (le popstate trouvera une pile vide).
    this.dropHistoryEntries();
    this.setState({ ...initialState(this.state.theme), auth });
  }

  /** Session terminée (déconnexion, compte supprimé, 401 en cours d'utilisation) : page de connexion. @param {string} [text] */
  signedOut(text) {
    // Plusieurs 401 arrivent ensemble (démarrage sans session) : une seule remise à zéro.
    if (this.state.auth || this.signedOutEpoch === this.epoch) return;
    this.resetSession({ screen: 'login' });
    this.signedOutEpoch = this.epoch;
    if (text) this.toast(text);
  }

  /** Page ouverte par un lien : inscription ou nouveau mot de passe ; le lien est vérifié tout de suite. @param {{ screen: 'signup', code: string } | { screen: 'reset', token: string }} route */
  openAuthRoute(route) {
    /** @type {Auth} */
    const auth = route.screen === 'signup' ? { screen: 'signup', code: route.code } : { screen: 'reset', token: route.token };
    this.setState({ auth, form: emptyForm() });
    const req = route.screen === 'signup' ? api.invite(route.code) : api.resetInfo(route.token);
    req.then((info) => this.setState((/** @type {State} */ s) => (s.auth === auth ? { auth: { ...auth, info } } : null)),
      (e) => this.setState((/** @type {State} */ s) => {
        if (!s.auth || (s.auth.code ?? s.auth.token) !== (auth.code ?? auth.token)) return null;
        // Lien inconnu, utilisé, expiré ou révoqué : aucune distinction. Autre échec : le formulaire reste utilisable.
        return { auth: e && e.status === 404 ? { ...s.auth, screen: 'invalid' } : { ...s.auth, infoFailed: true } };
      }));
  }

  /** Connexion (depuis un lien invalide, ou après une suppression) : l'adresse redevient '/'. */
  toLogin() {
    try { history.replaceState({ nav: 0 }, '', '/'); } catch { /* adresse inchangée */ }
    this.setState({ auth: { screen: 'login' }, form: emptyForm() });
  }

  /** @param {Partial<Form>} patch */
  setForm(patch) { this.setState((/** @type {State} */ s) => ({ form: { ...s.form, ...patch } })); }

  /** Envoi du formulaire de la page hors appli affichée. */
  submitAuth() {
    const a = this.state.auth, f = this.state.form;
    if (!a || f.busy) return;
    if (a.screen === 'invalid') { this.toLogin(); return; }
    const name = cleanName(f.name);
    this.setForm({ busy: true, error: null, bad: null });
    // Identifie cet envoi : l'objet auth change quand la lecture du lien arrive pendant la requête.
    const seq = ++this.authSeq;
    const req = a.screen === 'signup' ? api.signup(/** @type {string} */ (a.code), name, f.pw)
      : a.screen === 'reset' ? api.reset(/** @type {string} */ (a.token), f.pw)
      : api.login(name, f.pw);
    req.then((res) => {
      if (seq !== this.authSeq || !this.state.auth) return;
      this.enterApp(res.me, a.screen === 'signup' ? 'Compte « ' + res.me.username + ' » créé' : a.screen === 'reset' ? 'Mot de passe enregistré' : null);
    }, (e) => {
      if (seq !== this.authSeq || !this.state.auth) return;
      if (e && (e.code === 'invite_invalid' || e.code === 'reset_invalid')) this.setState((/** @type {State} */ s) => ({ auth: { ...(s.auth || a), screen: 'invalid' }, form: emptyForm() }));
      else {
        // Compte verrouillé 5 s après un échec (ou attente imposée) : bouton grisé pendant ce temps.
        const wait = e && e.code === 'invalid_credentials' ? 5 : e && e.code === 'too_many_attempts' ? (e.retryAfter || 5) : 0;
        this.setForm({ busy: false, error: authErrorText(e), bad: authErrorField(e), wait: wait > 0 });
        if (wait > 0) {
          clearTimeout(this.authWaitTimer);
          this.authWaitTimer = setTimeout(() => this.setForm({ wait: false }), wait * 1000);
        }
      }
    });
  }

  /** Session ouverte : entrée dans l'appli, à l'adresse '/'. @param {any} me @param {string | null} text */
  enterApp(me, text) {
    try { history.replaceState({ nav: 0 }, '', '/'); } catch { /* adresse inchangée */ }
    this.resetSession(null);
    // signedIn lit this.state.me : seulement une fois l'état appliqué (setState est différé).
    this.setState({ me }, () => this.signedIn());
    this.pendingScroll = 'anchor';
    this.loadTab('encours');
    if (text) this.toast(text);
  }

  // Les écritures en attente partent d'abord (sinon un swipe juste avant serait perdu).
  logout() {
    if (this.loggingOut) return;
    this.loggingOut = true;
    this.afterWrites(() => {
      // L'appareil cesse de recevoir les notifications du compte (le serveur les retire aussi avec la session).
      P.forgetPush().catch(() => {}).then(() => api.logout()).then(() => this.signedOut(), (e) => this.failToast(e, 'Déconnexion impossible'))
        .finally(() => { this.loggingOut = false; });
    });
  }

  // ---------- notifications ----------
  /** Session ouverte (démarrage ou connexion) : épisode d'une notification touchée, état des notifications de l'appareil. */
  signedIn() {
    const t = this.pendingOpen;
    this.pendingOpen = null;
    if (t) this.openNotified(t);
    this.initPush();
  }

  /** Fiche de l'épisode d'une notification, par-dessus l'écran courant (« retour » y ramène). @param {NonNullable<ReturnType<typeof P.notifTarget>>} t */
  openNotified(t) {
    if (this.state.auth || !this.state.me) { this.pendingOpen = t; return; }
    // Timeline pas encore placée : au retour, elle se cale sur « À regarder » (aucune position mémorisée).
    const unplaced = this.pendingScroll === 'anchor';
    this.setState(NO_OVERLAY);
    this.push(this.epView(t.show, t.name || undefined, { id: t.ep, season: t.season, number: t.number }));
    if (unplaced) { this.savedRel = null; this.savedTop = null; }
  }

  /** État de l'appareil ; la première fois, propose les notifications (ou l'installation sur iPhone). */
  initPush() {
    const me = this.state.me;
    if (!me) return;
    const epoch = this.epoch;
    P.syncPush(me.username).then((push) => {
      if (epoch !== this.epoch) return;
      this.setState({ push });
      if (!P.shouldAsk() || this.state.auth || hasOverlay(this.state) || this.state.stack.length) return;
      if (push === 'off' && P.permissionUndecided()) {
        P.markAsked();
        this.setState({ confirm: {
          title: 'Notifications',
          text: 'Être prévenu à la sortie d’un nouvel épisode d’une série suivie ?',
          ok: 'Oui', cancel: 'Non',
          action: () => { this.setPush(true); this.setState({ confirm: null }); },
        } });
      } else if (push === 'install') {
        P.markAsked();
        this.setState({ confirm: {
          title: 'Notifications',
          text: 'Pour être prévenu des nouveaux épisodes, ajouter l’appli à l’écran d’accueil : bouton Partager, puis « Sur l’écran d’accueil ».',
          ok: 'OK', cancel: null,
          action: () => this.setState({ confirm: null }),
        } });
      }
    }, () => { if (epoch === this.epoch && this.state.push === null) this.setState({ push: 'off' }); });
  }

  /** Interrupteur affiché tout de suite dans sa nouvelle position ; recalé sur le résultat. @param {boolean} on */
  setPush(on) {
    const me = this.state.me;
    if (!me || this.state.pushBusy) return;
    // Appelé directement depuis le geste : la demande de permission du navigateur doit en partir.
    const req = on ? P.enablePush(me.username) : P.disablePush();
    const before = this.state.push;
    const epoch = this.epoch;
    this.setState({ push: on ? 'on' : 'off', pushBusy: true });
    req.then((push) => {
      if (epoch !== this.epoch) return;
      this.setState({ push, pushBusy: false });
      if (on && push === 'off') this.toast('Notifications non autorisées');
    }, (e) => {
      if (epoch !== this.epoch) return;
      this.setState({ push: before, pushBusy: false });
      this.failToast(e, on ? 'Activation impossible' : 'Désactivation impossible');
    });
  }

  testPush() {
    const epoch = this.epoch;
    P.testPush().then((r) => {
      if (epoch !== this.epoch) return;
      if (r === 'sent') this.toast('Notification envoyée');
      else if (r === 'gone') {
        this.setState({ push: 'off' });
        this.toast('Cet appareil n’est plus abonné : réactiver les notifications');
      } else this.toast('Le service de notifications a refusé l’envoi');
    }, (e) => { if (epoch === this.epoch) this.failToast(e, 'Envoi impossible'); });
  }

  /** Échec d'une action : toast, sauf session terminée (la connexion s'affiche déjà). @param {any} e @param {string} text */
  failToast(e, text) {
    if (this.state.auth || (e && e.status === 401) || this.lostRights(e)) return;
    this.toast(text);
  }

  /**
   * 403 forbidden : le rôle a changé pendant l'utilisation (Parrain repassé Membre). Feuilles de compte fermées, rôle
   * relu, écrans qu'il n'autorise plus quittés. @param {any} e @returns {boolean} true si l'erreur est traitée ici
   */
  lostRights(e) {
    if (!e || e.code !== 'forbidden') return false;
    this.setState({ linkSheet: null, account: null });
    const epoch = this.epoch;
    this.loadMe().then((ok) => {
      const me = this.state.me;
      if (!ok || epoch !== this.epoch || !me) return;
      /** @param {View} v */
      const allowed = (v) => (v.type === 'invites' ? canInvite(me.role) : v.type === 'admin' ? me.role === 'admin' : true);
      const i = this.state.stack.findIndex((v) => !allowed(v));
      if (i >= 0) this.unwind(this.state.stack.length - i);
      this.toast('Accès retiré');
    });
    return true;
  }

  // ---------- mon compte ----------
  askDeleteSelf() { this.setState({ delSelf: { pw: '', show: false, busy: false, error: null, bad: null } }); }
  /** @param {Partial<DelSelf>} patch */
  setDelSelf(patch) { this.setState((/** @type {State} */ s) => (s.delSelf ? { delSelf: { ...s.delSelf, ...patch } } : null)); }
  confirmDeleteSelf() {
    const d = this.state.delSelf;
    if (!d || d.busy || !d.pw) return;
    this.setDelSelf({ busy: true, error: null, bad: null });
    api.deleteMe(d.pw).then(() => {
      P.forgetPush().catch(() => {});
      this.signedOut('Compte supprimé');
    }, (e) => {
      if (e && e.status === 401) return;
      this.setDelSelf({ busy: false, error: authErrorText(e), bad: authErrorField(e) });
    });
  }

  /** Export (RGPD) : aperçu dans une feuille ; le téléchargement part du bouton (geste de l'utilisateur, exigé par Safari). */
  openExport() {
    if (this.state.exportSheet) return;
    this.setState({ exportSheet: { data: null } });
    const epoch = this.epoch;
    api.exportMe('mes-series-' + this.today() + '.json').then(({ text, filename }) => {
      let preview = text, sub = 'JSON';
      try {
        const o = JSON.parse(text);
        preview = JSON.stringify(o, null, 2);
        sub = plural(o.episodes_vus.length, 'épisode vu', 'épisodes vus') + ' · ' + plural(o.series.length, 'série', 'séries') + ' · JSON';
      } catch { /* aperçu brut */ }
      if (preview.length > 1600) preview = preview.slice(0, 1600) + '…';
      this.setState((/** @type {State} */ s) => (s.exportSheet && epoch === this.epoch ? { exportSheet: { data: { text, preview, sub, filename } } } : null));
    }, (e) => {
      if (epoch !== this.epoch) return;
      this.setState({ exportSheet: null });
      this.failToast(e, 'Chargement impossible');
    });
  }
  downloadExport() {
    const x = this.state.exportSheet;
    if (!x || !x.data) return;
    const url = URL.createObjectURL(new Blob([x.data.text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = x.data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- import d'historique ----------
  openImport() {
    if (this.state.imp.step === 'done') this.setState({ imp: emptyImport() });
    this.push({ type: 'import', show: 0 });
  }
  /** @param {Partial<ImportState>} patch */
  setImportState(patch) { this.setState((/** @type {State} */ s) => ({ imp: { ...s.imp, ...patch } })); }
  /** @param {FileList} list */
  pickImportFiles(list) {
    const epoch = this.epoch;
    this.setImportState({ step: 'reading', error: null });
    Promise.all([...list].map((f) => f.text().then((text) => ({ name: f.name, text })))).then((files) => {
      if (epoch === this.epoch) this.setImportState({ files, step: 'pick' });
    }, () => { if (epoch === this.epoch) this.setImportState({ step: 'pick', error: 'Lecture des fichiers impossible' }); });
  }
  analyzeImport() {
    const x = this.state.imp;
    if (!x.files || x.step !== 'pick') return;
    const epoch = this.epoch;
    this.setImportState({ step: 'analyzing', error: null });
    api.analyzeImport(x.files).then((analysis) => {
      if (epoch !== this.epoch) return;
      /** @type {Record<string, number | null>} */
      const choices = {};
      for (const m of analysis.matches) choices[m.key] = m.choice;
      this.setImportState({ step: 'review', analysis, choices, extra: {}, searchFor: null });
    }, (e) => { if (epoch === this.epoch) this.setImportState({ step: 'pick', error: importErrorText(e) }); });
  }
  /** @param {string} key @param {number | null} id */
  chooseImport(key, id) { this.setState((/** @type {State} */ s) => ({ imp: { ...s.imp, choices: { ...s.imp.choices, [key]: id } } })); }
  /** @param {string} key @param {string} title */
  openImportSearch(key, title) {
    this.setImportState({ searchFor: key, searchQ: title, searchResults: null });
    this.searchImport(title);
  }
  /** Recherche TMDB pour une série à confirmer : 300 ms après la dernière frappe, réponses périmées ignorées. @param {string} q */
  searchImport(q) {
    this.setImportState({ searchQ: q });
    clearTimeout(this.importSearchTimer);
    const seq = ++this.importSearchSeq;
    if (q.trim().length < 2) { this.setImportState({ searchResults: null }); return; }
    this.importSearchTimer = setTimeout(() => {
      api.search(q.trim()).then((r) => { if (seq === this.importSearchSeq) this.setImportState({ searchResults: r.results.slice(0, 6) }); },
        () => { if (seq === this.importSearchSeq) this.setImportState({ searchResults: [] }); });
    }, 300);
  }
  /** Série trouvée par la recherche : ajoutée aux candidats et choisie. @param {string} key @param {any} r */
  pickImportSearch(key, r) {
    this.setState((/** @type {State} */ s) => ({ imp: { ...s.imp,
      extra: { ...s.imp.extra, [key]: [...(s.imp.extra[key] || []).filter((c) => c.id !== r.id), { id: r.id, name: r.name, year: r.year, seasonCount: r.seasonCount || 0, posterPath: r.posterPath }] },
      choices: { ...s.imp.choices, [key]: r.id }, searchFor: null, searchResults: null } }));
  }
  runImport() {
    const x = this.state.imp;
    if (!x.files || x.step !== 'review') return;
    const epoch = this.epoch;
    this.setImportState({ step: 'importing', error: null });
    api.importHistory(x.files, x.choices).then((r) => {
      if (epoch !== this.epoch) return;
      // Tout ce qui a été chargé est périmé : listes et fiches seront relues.
      this.setState((/** @type {State} */ s) => ({ imp: { ...s.imp, step: 'done', report: r.report, files: null, analysis: null }, tl: null, hist: null, shelf: null, mine: null, shows: {}, seasons: {} }));
    }, (e) => { if (epoch === this.epoch) this.setImportState({ step: 'review', error: importErrorText(e) }); });
  }
  closeImport() {
    this.setState({ imp: emptyImport() });
    this.back();
    this.loadTab(this.state.tab);
  }

  // ---------- à propos ----------
  openAbout() { this.push({ type: 'about', show: 0 }); }
  loadAbout() {
    if (this.state.about) return Promise.resolve(true);
    return this.once('about', () => this.read(() => api.about(), (d) => this.setState({ about: d }),
      () => { if (!this.state.about) this.setErr('about', true); }));
  }

  // ---------- parrainages ----------
  openInvites() { this.push({ type: 'invites', show: 0 }); }
  loadInvites() {
    return this.once('invites', () => this.read(() => api.invites(), (d) => this.setState({ invites: d.invites }),
      (e) => { if (!this.lostRights(e) && !this.state.invites) this.setErr('invites', true); }));
  }
  createInvite() {
    if (this.state.creatingInvite) return;
    this.setState({ creatingInvite: true });
    const epoch = this.epoch;
    api.createInvite().then(({ invite, url }) => {
      if (epoch !== this.epoch) return;
      this.setState((/** @type {State} */ s) => ({
        creatingInvite: false,
        invites: s.invites ? [invite, ...s.invites.filter((x) => x.id !== invite.id)] : s.invites,
        linkSheet: { title: 'Lien d’invitation', url, sub: 'Usage unique · expire ' + inDays(dayOf(invite.expiresAt, this.tz()), this.today()), inviteId: invite.id },
      }));
      if (!this.state.invites) this.loadInvites();
    }, (e) => {
      if (epoch !== this.epoch) return;
      this.setState({ creatingInvite: false });
      this.failToast(e, 'Création impossible');
    });
  }
  /** Lien en attente rouvert : le serveur n'en garde que l'empreinte, l'adresse n'est plus disponible. @param {any} inv */
  openInvite(inv) {
    const tz = this.tz(), today = this.today();
    this.setState({ linkSheet: {
      title: 'Lien d’invitation', url: null, inviteId: inv.id,
      sub: 'Lien du ' + fShort(dayOf(inv.createdAt, tz), today) + ' · expire ' + inDays(dayOf(inv.expiresAt, tz), today),
    } });
  }
  /** @param {number} id */
  revokeInvite(id) {
    if (this.revoking) return;
    this.revoking = true;
    const epoch = this.epoch;
    api.revokeInvite(id).then(() => {
      if (epoch !== this.epoch) return;
      this.setState((/** @type {State} */ s) => ({ linkSheet: null, invites: s.invites && s.invites.map((x) => (x.id === id ? { ...x, status: 'revoked' } : x)) }));
      this.toast('Lien révoqué');
    }, (e) => {
      if (epoch !== this.epoch) return;
      this.setState({ linkSheet: null });
      if (e && e.code === 'invite_used') { this.toast('Ce lien vient de servir'); this.loadInvites(); }
      else this.failToast(e, 'Révocation impossible');
    }).finally(() => { this.revoking = false; });
  }
  // Partage natif du téléphone si disponible, sinon copie.
  /** @param {string} url */
  shareLink(url) {
    if (navigator.share) navigator.share({ url }).catch(() => { /* partage annulé */ });
    else this.copyLink(url);
  }
  /** Le résultat s'affiche sur le bouton lui-même (un toast serait caché sous la feuille). @param {string} url */
  copyLink(url) {
    /** @param {'ok' | 'fail'} r */
    const done = (r) => this.setState((/** @type {State} */ s) => (s.linkSheet && s.linkSheet.url === url ? { linkSheet: { ...s.linkSheet, copied: r } } : null));
    try { navigator.clipboard.writeText(url).then(() => done('ok'), () => done('fail')); } catch { done('fail'); }
  }

  // ---------- comptes (admin) ----------
  openAdmin() { this.push({ type: 'admin', show: 0 }); }
  loadUsers() {
    return this.once('users', () => this.read(() => api.users(), (d) => this.setState({ users: d.users }),
      (e) => { if (!this.lostRights(e) && !this.state.users) this.setErr('users', true); }));
  }
  /** @param {number} id @param {'membre' | 'parrain'} role */
  setRole(id, role) {
    const u = this.state.users && this.state.users.find((x) => x.id === id);
    if (!u || u.role === role || u.role === 'admin') return;
    const seqs = this.roleSeq;
    const seq = (seqs[id] = (seqs[id] || 0) + 1);
    const epoch = this.epoch;
    /** @param {string} r */
    const put = (r) => this.setState((/** @type {State} */ s) => ({ users: s.users && s.users.map((x) => (x.id === id ? { ...x, role: r } : x)) }));
    put(role);
    // Seule la réponse au dernier choix fait foi (deux taps rapides).
    api.setUserRole(id, role).then((res) => {
      if (epoch === this.epoch && seqs[id] === seq && res && res.user) put(res.user.role);
    }, (e) => {
      if (epoch !== this.epoch || seqs[id] !== seq) return;
      // La feuille de compte est fermée : le toast passerait dessous.
      this.setState((/** @type {State} */ s) => (s.account === id ? { account: null } : null));
      this.failToast(e, 'Échec de l’enregistrement');
      this.loadUsers();
    });
  }
  /** @param {number} id */
  createReset(id) {
    const u = this.state.users && this.state.users.find((x) => x.id === id);
    if (!u || this.state.resetBusy) return;
    this.setState({ resetBusy: true });
    const epoch = this.epoch;
    api.resetLink(id).then(({ url }) => {
      if (epoch !== this.epoch) return;
      this.setState({ resetBusy: false, account: null, linkSheet: { title: 'Réinitialisation · ' + u.username, url, sub: 'Usage unique · valable 24 h' } });
    }, (e) => {
      if (epoch !== this.epoch) return;
      this.setState((/** @type {State} */ s) => ({ resetBusy: false, account: s.account === id ? null : s.account }));
      this.failToast(e, 'Création impossible');
    });
  }
  // Suppression (RGPD, droit à l'effacement) : les comptes qu'il a invités restent, affichés « invité par un compte supprimé ».
  /** @param {number} id */
  askDeleteUser(id) {
    const u = this.state.users && this.state.users.find((x) => x.id === id);
    if (!u) return;
    const name = u.username;
    this.setState({ account: null, confirm: {
      title: 'Supprimer le compte de ' + name + ' ?',
      text: 'Son historique de visionnage, ses séries suivies et ses liens d’invitation seront effacés définitivement.',
      ok: 'Supprimer le compte', danger: true,
      action: () => {
        this.setState({ confirm: null });
        const epoch = this.epoch;
        api.deleteUser(id).then(() => {
          if (epoch !== this.epoch) return;
          this.setState((/** @type {State} */ s) => ({
            users: s.users && s.users.filter((x) => x.id !== id).map((x) => (x.invitedBy === name ? { ...x, invitedBy: null, invitedByDeleted: true } : x)),
            invites: s.invites && s.invites.map((x) => (x.usedBy === name ? { ...x, usedBy: null, usedByDeleted: true } : x)),
          }));
          this.toast('Compte de ' + name + ' supprimé');
        }, (e) => {
          if (epoch !== this.epoch) return;
          this.failToast(e, 'Suppression impossible');
        });
      },
    } });
  }

  // ---------- recherche ----------
  /** @param {string} q */
  searchInput(q) {
    const t = q.trim();
    // Même recherche (espace ajoutée) : la requête en cours reste valable.
    if (t === this.searchTerm) { this.setState((/** @type {any} */ s) => ({ search: { ...s.search, q } })); return; }
    this.searchTerm = t;
    // Texte changé : la requête en cours est périmée dès maintenant, pas seulement au départ de la suivante.
    clearTimeout(this.searchTimer);
    if (this.searchCtl) this.searchCtl.abort();
    this.searchSeq++;
    if (t.length < 2) {
      this.setState({ search: { q, results: null, loading: false, error: false } });
      return;
    }
    this.setState((/** @type {any} */ s) => ({ search: { ...s.search, q, loading: true, error: false } }));
    this.searchTimer = setTimeout(() => this.runSearch(t), SEARCH_DEBOUNCE);
  }

  /** @param {string} t */
  runSearch(t) {
    if (this.searchCtl) this.searchCtl.abort();
    const ctl = new AbortController();
    this.searchCtl = ctl;
    const seq = ++this.searchSeq;
    api.search(t, ctl.signal).then((r) => {
      if (seq === this.searchSeq) this.setState((/** @type {any} */ s) => ({ search: { ...s.search, results: r.results, loading: false, error: false } }));
    }, (e) => {
      if (isAbort(e) || seq !== this.searchSeq) return;
      this.setState((/** @type {any} */ s) => ({ search: { ...s.search, results: null, loading: false, error: true } }));
    });
  }

  // ---------- navigation ----------
  saveScroll() {
    if (this.state.tab !== 'encours' || this.state.stack.length || !this.scroller) return;
    const a = /** @type {HTMLElement | null} */ (this.scroller.querySelector('[data-anchor]'));
    this.savedRel = a ? a.offsetTop - this.scroller.scrollTop : null;
    this.savedTop = this.scroller.scrollTop;
  }

  /** Écran affiché, repéré par sa profondeur dans la pile (une même fiche peut y être deux fois). @param {View[]} stack @param {string} tab */
  screenKey(stack, tab) {
    const top = stack[stack.length - 1];
    return stack.length + '|' + (top ? viewKey(top) : 'tab:' + tab);
  }
  /** Zone qui défile de l'écran affiché. @returns {HTMLElement | null} */
  screenScroller() { return this.mainEl ? /** @type {HTMLElement | null} */ (this.mainEl.querySelector('.scroll')) : null; }
  // La timeline a sa propre logique (position relative à « À regarder », voir saveScroll / placeScroll).
  rememberScroll() {
    const st = this.state;
    if (!st.stack.length && st.tab === 'encours') return;
    const el = this.screenScroller();
    if (el) this.scrollMemo.set(this.screenKey(st.stack, st.tab), el.scrollTop);
  }
  /** Données de l'écran affiché présentes (sinon il est encore en place réservée). @param {State} st */
  screenReady(st) {
    const top = st.stack[st.stack.length - 1];
    if (!top) return st.tab === 'decote' ? !!st.shelf : st.tab === 'series' ? !!st.mine : true;
    if (top.type === 'import' || top.type === 'about') return true;
    if (top.type === 'invites') return !!st.invites;
    if (top.type === 'admin') return !!st.users;
    if (top.type === 'show') return !!st.shows[top.show];
    return !!st.seasons[top.show + ':' + top.season];
  }
  // Retour sur un écran recouvert : même position qu'au moment où on l'a quitté.
  restoreScroll() {
    const key = this.pendingRestore;
    if (!key) return;
    const st = this.state;
    if (key !== this.screenKey(st.stack, st.tab)) { this.pendingRestore = null; return; }
    if (!this.screenReady(st)) return;
    const el = this.screenScroller();
    if (!el) return;
    const y = this.scrollMemo.get(key);
    this.scrollMemo.delete(key);
    this.pendingRestore = null;
    if (y != null) el.scrollTop = y;
  }

  /** @param {string} t */
  goTab(t) {
    // Les vues d'explorateur ouvertes sont abandonnées : on retire aussi leurs entrées d'historique.
    this.dropHistoryEntries();
    if (t === 'encours') { this.pendingScroll = 'anchor'; this.setPull(0, false); }
    this.touched = false;
    this.scrollMemo.clear();
    this.pendingRestore = null;
    // Entrée dans l'onglet : l'ordre est figé sur les données fraîches. Les listes de la visite précédente ne sont pas
    // réaffichées en attendant (elles seraient remplacées et réordonnées sous les yeux à l'arrivée de la réponse).
    /** @type {Partial<State>} */
    const reset = t === 'encours' ? { tl: null, hist: null, upcomingOpen: false } : t === 'decote' ? { shelf: null } : {};
    this.setState({ tab: t, stack: [], ...NO_OVERLAY, ...reset });
    this.loadTab(t);
  }

  // Navigation de l'explorateur :
  // - toucher un élément du contenu (épisode, saison, série) ouvre une vue par-dessus (push) ;
  // - le fil d'Ariane et « épisode précédent / suivant » se déplacent dans la hiérarchie sans empiler ;
  // - « retour » revient à l'écran qui a ouvert la vue courante (pop), jusqu'à l'onglet d'origine.
  /** @param {View} view */
  push(view) {
    this.saveScroll();
    this.rememberScroll();
    const stack = this.state.stack.concat([view]);
    // Vue ouverte depuis une feuille (qui se ferme) : l'entrée de la feuille devient celle de la vue.
    if (this.useHistory) {
      try {
        if (this.sheetEntry) { this.sheetEntry = false; history.replaceState({ nav: stack.length }, ''); }
        else history.pushState({ nav: stack.length }, '');
      } catch { this.useHistory = false; }
    }
    this.setState({ stack });
  }
  /** @param {View} a @param {View} b */
  sameView(a, b) { return viewKey(a) === viewKey(b); }
  /** Revenir n vues en arrière : via l'historique si disponible (popstate fera le travail), sinon directement. @param {number} n */
  unwind(n) {
    if (n <= 0) return;
    if (this.useHistory) history.go(-n);
    else this.trimTo(this.state.stack.length - n);
  }
  /** @param {number} depth */
  trimTo(depth) {
    if (this.state.stack.length <= depth) return;
    const stack = this.state.stack.slice(0, Math.max(0, depth));
    if (!stack.length && this.state.tab === 'encours') this.pendingScroll = 'restore';
    else this.pendingRestore = this.screenKey(stack, this.state.tab);
    this.setState({ stack, confirm: null });
  }
  /** @param {PopStateEvent} ev */
  handlePop(ev) {
    // Retour système feuille ouverte : il ferme la feuille, l'écran dessous ne bouge pas.
    if (this.sheetEntry) { this.sheetEntry = false; this.setState(NO_OVERLAY); return; }
    // « Suivant » du navigateur vers l'entrée d'une feuille déjà fermée : on la ressaute.
    if (ev.state && ev.state.sheet) { history.back(); return; }
    const nav = ev.state && typeof ev.state.nav === 'number' ? ev.state.nav : 0;
    // Entrée plus profonde que la pile (« suivant » du navigateur, entrées laissées par un rechargement) :
    // on revient à l'entrée qui correspond à la pile, sinon les retours suivants ne feraient rien.
    if (nav > this.state.stack.length) { history.go(this.state.stack.length - nav); return; }
    this.trimTo(nav);
  }
  /** @param {View} view */
  crumbTo(view) {
    const stack = this.state.stack;
    const i = stack.findIndex((v) => this.sameView(v, view));
    if (i >= 0) this.unwind(stack.length - (i + 1));
    else this.replaceTop(view);
  }
  /** @param {View} view */
  replaceTop(view) { this.setState({ stack: this.state.stack.slice(0, -1).concat([view]) }); }
  back() { this.unwind(1); }
  /** @param {{ id: number, name?: string }} show */
  openShow(show) { this.push({ type: 'show', show: show.id, name: show.name }); }
  /** @param {number} showId @param {number} n @param {string} [name] */
  openSeason(showId, n, name) { this.push({ type: 'season', show: showId, name, season: n }); }
  /** @param {{ id: number, name?: string }} show @param {{ id: number, season: number, number: number }} ep */
  openEp(show, ep) { this.push(this.epView(show.id, show.name, ep)); }
  /** @param {number} showId @param {string | undefined} name @param {{ id: number, season: number, number: number }} ep @returns {View} */
  epView(showId, name, ep) { return { type: 'episode', show: showId, name, season: ep.season, number: ep.number, ep: ep.id }; }

  // ---------- défilement de la timeline ----------
  anchors() {
    const el = this.scroller;
    if (!el) return null;
    const a = /** @type {HTMLElement | null} */ (el.querySelector('[data-anchor]'));
    if (!a) return null;
    return { el, a, A: Math.max(0, a.offsetTop + a.offsetHeight - el.clientHeight) };
  }
  placeScroll() {
    if (!this.pendingScroll || !this.scroller || this.state.tab !== 'encours' || this.state.stack.length) return;
    const p = this.anchors();
    if (!p) return;                                  // données pas encore là : on placera au prochain rendu
    if (this.pendingScroll === 'restore' && this.savedRel != null) p.el.scrollTop = p.a.offsetTop - this.savedRel;
    else if (this.pendingScroll === 'restore' && this.savedTop != null) p.el.scrollTop = this.savedTop;
    else p.el.scrollTop = p.A;
    this.pendingScroll = null;
  }
  // Un épisode ajouté/retiré dans l'historique (au-dessus) ne doit pas faire bouger « À regarder » à l'écran.
  captureAnchor() {
    if (this.state.tab !== 'encours' || this.state.stack.length || !this.scroller || this.pendingScroll) return;
    const a = /** @type {HTMLElement | null} */ (this.scroller.querySelector('[data-anchor]'));
    if (a) this.anchorKeep = { off: a.offsetTop, top: this.scroller.scrollTop };
  }
  keepAnchor() {
    const k = this.anchorKeep;
    this.anchorKeep = null;
    if (!k || !this.scroller) return;
    const a = /** @type {HTMLElement | null} */ (this.scroller.querySelector('[data-anchor]'));
    if (!a) return;
    // Seulement si l'ancre a bougé : réécrire scrollTop sans raison peut couper un défilement lancé.
    const top = k.top + (a.offsetTop - k.off);
    if (Math.abs(top - this.scroller.scrollTop) >= 1) this.scroller.scrollTop = top;
  }
  // « À venir » fermé n'est pas dans la page : tout défilement bute sur la poignée.
  // On l'ouvre en tirant au-delà de la fin (résistance, aperçu, poignée ambre au seuil).
  maxTop() { const el = /** @type {HTMLElement} */ (this.scroller); return el.scrollHeight - el.clientHeight; }
  /** @param {number} px @param {boolean} animate */
  setPull(px, animate) {
    this.pull = px;
    const tr = animate ? 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.3s ease' : 'none';
    if (this.content) { this.content.style.transition = tr; this.content.style.transform = px ? 'translateY(' + (-px) + 'px)' : ''; }
    if (this.peekEl) { this.peekEl.style.transition = tr; this.peekEl.style.opacity = String(Math.min(1, px / PULL_OPEN)); }
    if (this.peekInner) { this.peekInner.style.transition = tr; this.peekInner.style.transform = 'translateY(' + (260 - px) + 'px)'; }
    if (this.handle) this.handle.style.background = px >= PULL_OPEN ? 'var(--accent)' : 'var(--line2)';
  }
  /** @param {number} y */
  pullMove(y) {
    if (this.state.upcomingOpen || !this.scroller) return;
    if (this.scroller.scrollTop < this.maxTop() - 1) { if (this.pull) this.setPull(0, false); this.pullOrigin = null; return; }
    if (this.pullOrigin == null) this.pullOrigin = y;
    const d = this.pullOrigin - y;
    this.setPull(d > 0 ? Math.min(240, d * 0.45) : 0, false);
  }
  pullEnd() {
    this.pullOrigin = null;
    if (this.state.upcomingOpen || !this.pull) return;
    if (this.pull >= PULL_OPEN) this.openUpcoming(); else this.setPull(0, true);
  }
  openUpcoming() { this.pendingOpenShift = this.pull || 0; this.setState({ upcomingOpen: true }); }
  handleScroll() {
    this.maybeLoadOlder();
    if (!this.state.upcomingOpen || this.pendingOpenShift != null) return;
    const p = this.anchors();
    if (p && p.el.scrollTop <= p.A + 2) this.setState({ upcomingOpen: false });
  }
  /** @param {WheelEvent} ev */
  handleWheel(ev) {
    if (this.state.upcomingOpen || !this.scroller || ev.deltaY <= 0) return;
    if (this.scroller.scrollTop < this.maxTop() - 1) return;
    this.wheelAcc = (this.wheelAcc || 0) + ev.deltaY;
    clearTimeout(this.wheelTimer);
    this.setPull(Math.min(240, this.wheelAcc * 0.3), false);
    if (/** @type {number} */ (this.pull) >= PULL_OPEN) { this.wheelAcc = 0; this.openUpcoming(); return; }
    this.wheelTimer = setTimeout(() => { this.wheelAcc = 0; this.setPull(0, true); }, 220);
  }

  // ---------- swipe façon Gmail (deux sens, seuil) ----------
  /** @param {string} id @param {boolean} enabled @param {() => void} commit */
  swipe(id, enabled, commit) {
    const d = this.state.drag;
    const active = d && d.id === id;
    const dx = active ? d.dx : 0;
    const armed = Math.abs(dx) >= THRESHOLD;
    return {
      dx,
      tr: active && !d.release ? 'none' : 'transform 0.22s ease',
      bg: armed ? 'var(--ok-strong)' : 'var(--chip2)',
      fg: armed ? 'var(--on-armed)' : 'var(--faint)',
      op: active ? Math.min(1, 0.35 + Math.abs(dx) / THRESHOLD) : 0,
      down: (/** @type {PointerEvent} */ ev) => {
        if (!enabled || (ev.button !== undefined && ev.button !== 0)) return;
        this.g = { id, commit, x0: ev.clientX, y0: ev.clientY, pid: ev.pointerId, el: /** @type {Element} */ (ev.currentTarget), mode: /** @type {string | null} */ (null) };
      },
      move: (/** @type {PointerEvent} */ ev) => {
        const g = this.g;
        if (!g || ev.pointerId !== g.pid) return;
        const mx = ev.clientX - g.x0, my = ev.clientY - g.y0;
        if (!g.mode) {
          if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) { g.mode = 'h'; try { g.el.setPointerCapture(g.pid); } catch { /* capture impossible : le geste continue sans */ } }
          else if (Math.abs(my) > 8) g.mode = 'v';
        }
        if (g.mode !== 'h') return;
        let v = mx;
        if (Math.abs(v) > THRESHOLD) v = Math.sign(v) * (THRESHOLD + (Math.abs(v) - THRESHOLD) * 0.5);
        this.setState({ drag: { id: g.id, dx: v } });
      },
      up: () => this.endSwipe(false),
      cancel: () => this.endSwipe(true),
    };
  }
  /** @param {boolean} cancelled */
  endSwipe(cancelled) {
    const g = this.g;
    this.g = null;
    if (!g) return;
    if (g.mode === 'h') { this.suppress = true; setTimeout(() => { this.suppress = false; }, 60); }
    const d = this.state.drag;
    if (!cancelled && g.mode === 'h' && d && d.id === g.id && Math.abs(d.dx) >= THRESHOLD) {
      this.setState({ drag: { id: g.id, dx: Math.sign(d.dx) * 460, release: true } });
      // Ne remet à zéro que ce geste : un autre swipe a pu commencer entre-temps.
      setTimeout(() => { g.commit(); this.setState((/** @type {any} */ s) => (s.drag && s.drag.id === g.id ? { drag: null } : null)); }, 200);
    } else if (d) this.setState({ drag: null });
  }
  /** Tap qui ne part pas juste après un swipe. @param {() => void} fn */
  tap(fn) { return () => { if (this.suppress) return; fn(); }; }

  // Sens du glissement : pile qui grandit = avant, qui diminue = arrière. À profondeur égale (fil d'Ariane,
  // épisode précédent/suivant) : on compare la position dans la hiérarchie série › saison › épisode, puis l'ordre.
  /** @param {View | undefined} from @param {View | undefined} to @param {number} d0 @param {number} d1 */
  slideDir(from, to, d0, d1) {
    if (d1 !== d0) return d1 > d0 ? 'v-fwd' : 'v-back';
    /** @param {View | undefined} v */
    const pos = (v) => (!v ? [-1, 0, 0] : v.type === 'show' ? [0, 0, 0] : v.type === 'season' ? [1, v.season || 0, 0] : [2, v.season || 0, v.number || 0]);
    const a = pos(from), b = pos(to);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i] ? 'v-fwd' : 'v-back';
    return 'v-fwd';
  }

  /** @param {any} _props @param {any} st */
  render(_props, st) {
    const toast = st.toast ? html`<div role="status" class="toast toast-in">
        <span class="ell" style="flex: 1; min-width: 0; font-size: 13px">${st.toast.text}</span>
        <button type="button" hidden=${!st.toast.undo} onClick=${st.toast.undo} style="flex: none; height: 44px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; color: var(--accent); font: 700 13px var(--text); cursor: pointer">Annuler</button>
      </div>` : null;
    if (st.auth) return html`${viewAuth(this, st)}${toast}`;
    const top = st.stack[st.stack.length - 1];
    let screen;
    if (top && top.type === 'import') screen = viewImport(this, st.imp);
    else if (top && top.type === 'about') screen = viewAbout(this, st);
    else if (top && top.type === 'invites') screen = viewInvites(this, st);
    else if (top && top.type === 'admin') screen = viewAdmin(this, st);
    else if (top && top.type === 'show') screen = viewShow(this, st, top);
    else if (top && top.type === 'season') screen = viewSeason(this, st, top);
    else if (top && top.type === 'episode') screen = viewEpisode(this, st, top);
    else if (st.tab === 'decote') screen = viewDecote(this, st);
    else if (st.tab === 'series') screen = viewSeries(this, st);
    else if (st.tab === 'profil') screen = viewProfil(this, st);
    else screen = viewEncours(this, st);
    // Transition d'écran : glissement uniquement, jamais de fondu ; changement d'onglet sans transition.
    const vkey = top ? viewKey(top) : 'tab:' + st.tab;
    if (vkey !== this.lastView) {
      this.viewAnim = this.lastView == null || st.tab !== this.lastTab ? '' : this.slideDir(this.lastTop, top, this.lastDepth, st.stack.length) + (this.lastTop && top ? ' v-keephdr' : '');
      this.lastView = vkey; this.lastTop = top; this.lastTab = st.tab; this.lastDepth = st.stack.length;
    }
    const account = st.account != null && st.users ? st.users.find((/** @type {any} */ u) => u.id === st.account) : null;
    /** @param {string} id @param {string} label @param {any} icon */
    const tab =(id, label, icon) => html`<button type="button" class="tab" aria-current=${st.tab === id ? 'page' : null} style="color: ${st.tab === id ? 'var(--accent)' : 'var(--muted)'}" onClick=${() => this.goTab(id)}>${icon}${label}</button>`;
    return html`
      <div class="main" ref=${this.setMain}><div key=${vkey} class=${'view ' + this.viewAnim}>${screen}</div></div>
      ${toast}
      <nav class="tabs" aria-label="Onglets">
        ${tab('encours', 'En cours', I.tv())}${tab('decote', 'De côté', I.box())}${tab('series', 'Mes séries', I.search())}${tab('profil', 'Profil', I.user())}
      </nav>
      ${st.confirm ? confirmSheet(st.confirm, this.closeConfirm) : null}
      ${st.picker ? pickerSheet(st.picker, this.closePicker) : null}
      ${st.linkSheet ? linkSheetView(this, st.linkSheet) : null}
      ${st.exportSheet ? exportSheetView(this, st.exportSheet) : null}
      ${account ? accountSheet(this, st, account) : null}
      ${st.delSelf ? deleteSelfSheet(this, st.delSelf) : null}`;
  }
}
