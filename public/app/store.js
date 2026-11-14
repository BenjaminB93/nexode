// @ts-check
// Transformations pures de l'état client (aucun DOM, aucun réseau) : mises à jour optimistes, recalage sur la réponse
// du serveur, instantané et restauration pour l'annulation ou l'échec. Chaque fonction rend un état partiel à fusionner.

import { compareEp } from './format.js';

/**
 * @typedef {{ id: number, season: number, number: number, title: string | null, titleIsVo: boolean, airDate: string | null }} Ep
 * @typedef {{ id: number, name: string, posterPath: string | null }} ShowRef
 * @typedef {{ id: number, relation: string, status: string | null, wouldBeStatus: string, next: Ep | null, remaining: number, seen: number, total: number }} ShowState
 * @typedef {{ episodeId: number, watchedAt: string, watchedDay: string, show: ShowRef, season: number, number: number, retired: boolean, title: string | null, titleIsVo: boolean }} HistItem
 *
 * Changement de l'état vu d'épisodes d'une série.
 * eps : épisodes connus qui changent d'état (tous sortis) ; count : nombre total d'épisodes sortis qui changent
 * (peut dépasser eps.length si des saisons ne sont pas chargées) ; upTo / seasonsAll : couverture d'un
 * « tout vu jusqu'ici » ou d'une coche de saison, pour retirer aussi ce qui n'est pas chargé.
 * @typedef {{ showId: number, on: boolean, eps: Ep[], count: number, upTo?: Ep, seasonsAll?: number[], at: string, day: string, show: ShowRef }} Change
 */

/** @param {any} e @returns {Ep} */
export const epOf = (e) => ({ id: e.id, season: e.season, number: e.number, title: e.title ?? null, titleIsVo: !!e.titleIsVo, airDate: e.airDate ?? null });

/** Épisodes à voir connus, dans l'ordre : next puis upNext. @param {{ next: Ep | null, upNext?: Ep[] }} x */
export function pendingOf(x) {
  const rest = x.upNext ? [...x.upNext] : [];
  return x.next ? [x.next, ...rest] : rest;
}

/**
 * Nouvelle tête de file (next, upNext, remaining) après un changement. next null avec remaining > 0 = prochain inconnu
 * (en attente du serveur).
 * @param {{ next: Ep | null, upNext?: Ep[], remaining: number }} x @param {Change} ch
 */
export function shiftPending(x, ch) {
  let list = pendingOf(x);
  let remaining;
  if (ch.on) {
    const ids = new Set(ch.eps.map((e) => e.id));
    const upTo = ch.upTo;
    list = list.filter((e) => !ids.has(e.id) && !(upTo && compareEp(e, upTo) <= 0) && !(ch.seasonsAll && ch.seasonsAll.includes(e.season)));
    remaining = Math.max(0, x.remaining - ch.count);
  } else {
    // Liste complète : on sait où insérer n'importe quel épisode ; sinon seulement avant le dernier connu.
    const complete = list.length >= x.remaining;
    for (const ep of [...ch.eps].sort(compareEp)) {
      if (list.some((e) => e.id === ep.id)) continue;
      const last = list[list.length - 1];
      if (complete || (last && compareEp(ep, last) < 0)) {
        list.push(ep);
        list.sort(compareEp);
      }
    }
    remaining = x.remaining + ch.count;
  }
  return { next: list[0] ?? null, upNext: list.slice(1), remaining };
}

/** @param {HistItem} a @param {HistItem} b */
const histOrder = (a, b) => (a.watchedAt < b.watchedAt ? 1 : a.watchedAt > b.watchedAt ? -1 : b.episodeId - a.episodeId);

/** Ajoute des éléments à l'historique (du plus récent au plus ancien), sans doublon. @param {HistItem[]} items @param {HistItem[]} added */
export function addHistory(items, added) {
  if (!added.length) return items;
  const ids = new Set(added.map((x) => x.episodeId));
  return items.filter((x) => !ids.has(x.episodeId)).concat(added).sort(histOrder);
}

/** @param {HistItem[]} items @param {number[]} ids */
export function removeHistory(items, ids) {
  const set = new Set(ids);
  return items.filter((x) => !set.has(x.episodeId));
}

/** @param {Record<string, any>} seasons @param {number} showId */
function seasonKeysOf(seasons, showId) {
  const prefix = showId + ':';
  return Object.keys(seasons).filter((k) => k.startsWith(prefix));
}

/**
 * Mise à jour optimiste de tous les écrans concernés par un changement vu / non vu.
 * Renvoie l'état partiel et ce qu'il faut pour défaire l'historique (ajoutés / retirés).
 * @param {any} s état courant @param {Change} ch
 * @returns {{ patch: Record<string, any>, histAdded: number[], histRemoved: HistItem[] }}
 */
export function applyChange(s, ch) {
  /** @type {Record<string, any>} */
  const patch = {};
  const id = ch.showId;
  const sign = ch.on ? 1 : -1;
  const ids = new Set(ch.eps.map((e) => e.id));

  const e = s.tl && s.tl.entries[id];
  if (e) {
    const p = shiftPending(e, ch);
    patch.tl = { ...s.tl, entries: { ...s.tl.entries, [id]: { ...e, ...p } } };
  }

  const c = s.shelf && s.shelf.cards[id];
  if (c) {
    const p = shiftPending({ next: c.next, remaining: c.remaining }, ch);
    const back = c.back || (ch.on && c.reason.kind !== 'manual');
    patch.shelf = { ...s.shelf, cards: { ...s.shelf.cards, [id]: { ...c, next: p.next, remaining: p.remaining, back } } };
  }

  if (s.mine && s.mine.rows.some((/** @type {any} */ r) => r.id === id)) {
    patch.mine = { ...s.mine, rows: s.mine.rows.map((/** @type {any} */ r) => (r.id === id ? { ...r, seen: Math.max(0, r.seen + sign * ch.count) } : r)) };
  }

  const d = s.shows[id];
  if (d && d.seasons) {
    const p = shiftPending({ next: d.next, remaining: d.remaining }, ch);
    /** @type {Map<number, number>} */
    const perSeason = new Map();
    for (const ep of ch.eps) perSeason.set(ep.season, (perSeason.get(ep.season) || 0) + 1);
    const seasons = d.seasons.map((/** @type {any} */ se) => {
      const full = ch.on && ((ch.seasonsAll && ch.seasonsAll.includes(se.number)) || (ch.upTo && se.number < ch.upTo.season));
      if (full) return { ...se, seen: Math.max(se.seen, se.aired) };
      const n = perSeason.get(se.number) || 0;
      return n ? { ...se, seen: Math.max(0, se.seen + sign * n) } : se;
    });
    patch.shows = { ...s.shows, [id]: { ...d, next: p.next, remaining: p.remaining, seen: Math.max(0, d.seen + sign * ch.count), seasons } };
  }

  // Saisons en cache : état vu des épisodes, et décalage du compteur « jusqu'ici » des saisons suivantes.
  const keys = seasonKeysOf(s.seasons, id);
  if (keys.length) {
    const seasons = { ...s.seasons };
    for (const k of keys) {
      const sc = seasons[k];
      const n = sc.data.season.number;
      const before = ch.eps.filter((ep) => ep.season < n).length;
      const touched = sc.data.episodes.some((/** @type {any} */ ep) => ids.has(ep.id));
      if (!touched && !before) continue;
      const episodes = touched
        ? sc.data.episodes.map((/** @type {any} */ ep) => (ids.has(ep.id)
          ? { ...ep, watchedAt: ch.on ? ch.at : null, watchedDay: ch.on ? ch.day : null }
          : ep))
        : sc.data.episodes;
      seasons[k] = { ...sc, base: sc.base - sign * before, data: { ...sc.data, episodes } };
    }
    patch.seasons = seasons;
  }

  /** @type {number[]} */
  let histAdded = [];
  /** @type {HistItem[]} */
  let histRemoved = [];
  if (s.hist) {
    if (ch.on) {
      const t0 = Date.parse(ch.at);
      const added = [...ch.eps].sort(compareEp).map((ep, i) => ({
        episodeId: ep.id, watchedAt: new Date(t0 + i).toISOString(), watchedDay: ch.day, show: ch.show,
        season: ep.season, number: ep.number, retired: false, title: ep.title, titleIsVo: ep.titleIsVo,
      }));
      histAdded = added.map((x) => x.episodeId);
      patch.hist = { ...s.hist, items: addHistory(s.hist.items, added) };
    } else {
      histRemoved = s.hist.items.filter((/** @type {HistItem} */ x) => ids.has(x.episodeId));
      if (histRemoved.length) patch.hist = { ...s.hist, items: removeHistory(s.hist.items, [...ids]) };
    }
  }
  return { patch, histAdded, histRemoved };
}

/**
 * Instantané de tout ce qui concerne une série (références : l'état est toujours remplacé, jamais modifié).
 * @param {any} s @param {number} id
 */
export function snapshot(s, id) {
  /** @type {Record<string, any>} */
  const seasons = {};
  for (const k of seasonKeysOf(s.seasons, id)) seasons[k] = s.seasons[k];
  return {
    tl: s.tl ? s.tl.entries[id] : undefined,
    shelf: s.shelf ? s.shelf.cards[id] : undefined,
    mine: s.mine ? s.mine.rows.find((/** @type {any} */ r) => r.id === id) : undefined,
    show: s.shows[id],
    seasons,
    result: s.search.results ? s.search.results.find((/** @type {any} */ r) => r.id === id) : undefined,
  };
}

/**
 * Remet une série dans l'état d'un instantané ; l'historique est défait à part (ajoutés retirés, retirés remis).
 * @param {any} s @param {number} id @param {ReturnType<typeof snapshot>} snap
 * @param {number[]} histAdded @param {HistItem[]} histRemoved
 */
export function restore(s, id, snap, histAdded, histRemoved) {
  /** @type {Record<string, any>} */
  const patch = {};
  if (s.tl && snap.tl && s.tl.entries[id]) patch.tl = { ...s.tl, entries: { ...s.tl.entries, [id]: snap.tl } };
  if (s.shelf && snap.shelf && s.shelf.cards[id]) patch.shelf = { ...s.shelf, cards: { ...s.shelf.cards, [id]: snap.shelf } };
  if (s.mine && snap.mine) patch.mine = { ...s.mine, rows: s.mine.rows.map((/** @type {any} */ r) => (r.id === id ? snap.mine : r)) };
  if (snap.show) patch.shows = { ...s.shows, [id]: snap.show };
  const keys = Object.keys(snap.seasons);
  if (keys.length) {
    const seasons = { ...s.seasons };
    for (const k of keys) seasons[k] = snap.seasons[k];
    patch.seasons = seasons;
  }
  if (s.search.results && snap.result) {
    patch.search = { ...s.search, results: s.search.results.map((/** @type {any} */ r) => (r.id === id ? snap.result : r)) };
  }
  if (s.hist && (histAdded.length || histRemoved.length)) {
    patch.hist = { ...s.hist, items: addHistory(removeHistory(s.hist.items, histAdded), histRemoved) };
  }
  return patch;
}

/**
 * Recalage sur l'état renvoyé par le serveur après une écriture. needUpNext : la file connue de « À regarder »
 * est épuisée alors qu'il reste des épisodes (il faut redemander la timeline).
 * @param {any} s @param {ShowState} st
 * @returns {{ patch: Record<string, any>, needUpNext: boolean }}
 */
export function applyShowState(s, st) {
  /** @type {Record<string, any>} */
  const patch = {};
  const id = st.id;
  let needUpNext = false;

  const e = s.tl && s.tl.entries[id];
  if (e) {
    let upNext = e.upNext || [];
    if (!st.next) upNext = [];
    else if (!(e.next && e.next.id === st.next.id)) {
      const i = upNext.findIndex((/** @type {Ep} */ x) => x.id === st.next?.id);
      upNext = i >= 0 ? upNext.slice(i + 1) : [];
    }
    needUpNext = !!st.next && st.remaining > 1 && upNext.length === 0;
    patch.tl = { ...s.tl, entries: { ...s.tl.entries, [id]: { ...e, next: st.next, upNext, remaining: st.remaining, status: st.status, relation: st.relation } } };
  }

  // « Repasse dans En cours » = la série n'est plus de côté (relation 'on'), y compris si elle est désormais à jour ou terminée.
  const c = s.shelf && s.shelf.cards[id];
  if (c) patch.shelf = { ...s.shelf, cards: { ...s.shelf.cards, [id]: { ...c, next: st.next, remaining: st.remaining, back: st.relation === 'on', relation: st.relation } } };

  if (s.mine && s.mine.rows.some((/** @type {any} */ r) => r.id === id)) {
    patch.mine = { ...s.mine, rows: s.mine.rows.map((/** @type {any} */ r) => (r.id === id ? { ...r, seen: st.seen, total: st.total, relation: st.relation, status: st.status } : r)) };
  }

  const d = s.shows[id];
  if (d && d.seasons) {
    patch.shows = { ...s.shows, [id]: { ...d, relation: st.relation, status: st.status, wouldBeStatus: st.wouldBeStatus, next: st.next, remaining: st.remaining, seen: st.seen, total: st.total } };
  }

  // Relation reprise dans les saisons en cache (fiche saison / épisode).
  const keys = seasonKeysOf(s.seasons, id);
  if (keys.length) {
    const seasons = { ...s.seasons };
    for (const k of keys) seasons[k] = { ...seasons[k], data: { ...seasons[k].data, show: { ...seasons[k].data.show, relation: st.relation } } };
    patch.seasons = seasons;
  }

  if (s.search.results && s.search.results.some((/** @type {any} */ r) => r.id === id)) {
    patch.search = { ...s.search, results: s.search.results.map((/** @type {any} */ r) => (r.id === id
      ? { ...r, relation: st.relation, status: st.status, seen: r.cached ? st.seen : r.seen, total: r.cached ? st.total : r.total }
      : r)) };
  }
  return { patch, needUpNext };
}

/**
 * Changement de suivi, affiché tout de suite. Le statut de la position du milieu ne bouge pas au moment du tap ;
 * une série remise « En cours » reprend le statut qu'elle aurait (wouldBeStatus) en attendant le serveur.
 * @param {any} s @param {number} id @param {'none' | 'on' | 'shelf'} to
 */
export function applyRelation(s, id, to) {
  /** @type {Record<string, any>} */
  const patch = {};
  const d = s.shows[id];
  const onStatus = d && d.wouldBeStatus ? d.wouldBeStatus : 'encours';
  /** @param {string | null} cur */
  const statusFor = (cur) => (to === 'none' ? null : to === 'shelf' ? 'decote' : cur && cur !== 'decote' ? cur : onStatus);
  if (d) patch.shows = { ...s.shows, [id]: { ...d, relation: to, status: statusFor(d.status) } };
  if (s.tl && s.tl.entries[id]) patch.tl = { ...s.tl, entries: { ...s.tl.entries, [id]: { ...s.tl.entries[id], relation: to } } };
  if (s.shelf && s.shelf.cards[id]) patch.shelf = { ...s.shelf, cards: { ...s.shelf.cards, [id]: { ...s.shelf.cards[id], relation: to } } };
  if (s.mine && s.mine.rows.some((/** @type {any} */ r) => r.id === id)) {
    patch.mine = { ...s.mine, rows: s.mine.rows.map((/** @type {any} */ r) => (r.id === id ? { ...r, relation: to, status: statusFor(r.status) } : r)) };
  }
  if (s.search.results && s.search.results.some((/** @type {any} */ r) => r.id === id)) {
    patch.search = { ...s.search, results: s.search.results.map((/** @type {any} */ r) => (r.id === id ? { ...r, relation: to, status: statusFor(r.status) } : r)) };
  }
  const keys = seasonKeysOf(s.seasons, id);
  if (keys.length) {
    const seasons = { ...s.seasons };
    for (const k of keys) seasons[k] = { ...seasons[k], data: { ...seasons[k].data, show: { ...seasons[k].data.show, relation: to } } };
    patch.seasons = seasons;
  }
  return patch;
}

/**
 * Données de la timeline reçues du serveur. Ordre figé : refreeze = true à l'entrée dans l'onglet (aucune action depuis),
 * sinon les séries déjà affichées gardent leur place et les nouvelles attendent la prochaine entrée.
 * @param {any} prev ancien s.tl (ou null) @param {any} data réponse GET /api/timeline @param {boolean} refreeze
 */
export function timelineFrom(prev, data, refreeze) {
  /** @type {Record<number, any>} */
  const entries = refreeze || !prev ? {} : { ...prev.entries };
  for (const x of data.toWatch) {
    entries[x.show.id] = { show: x.show, next: x.next, upNext: x.upNext || [], remaining: x.remaining, status: 'encours', relation: 'on' };
  }
  const order = refreeze || !prev ? data.toWatch.map((/** @type {any} */ x) => x.show.id) : prev.order;
  return { entries, order, upcoming: data.upcoming };
}

/**
 * Complète la file des séries dont le prochain épisode est inchangé (après une série de swipes rapides).
 * @param {any} tl @param {any} data réponse GET /api/timeline
 */
export function mergeUpNext(tl, data) {
  const entries = { ...tl.entries };
  for (const x of data.toWatch) {
    const e = entries[x.show.id];
    if (e && e.next && x.next && e.next.id === x.next.id && x.upNext) entries[x.show.id] = { ...e, upNext: x.upNext, remaining: x.remaining };
  }
  return { ...tl, entries, upcoming: data.upcoming };
}

/** @param {any} prev @param {any} data réponse GET /api/shelf @param {boolean} refreeze */
export function shelfFrom(prev, data, refreeze) {
  /** @type {Record<number, any>} */
  const cards = refreeze || !prev ? {} : { ...prev.cards };
  /** @param {any} x */
  const put = (x) => { cards[x.show.id] = { show: x.show, reason: x.reason, next: x.next, remaining: x.remaining, back: false, relation: 'shelf' }; };
  data.notStarted.forEach(put);
  data.abandoned.forEach(put);
  if (refreeze || !prev) {
    return { cards, notStarted: data.notStarted.map((/** @type {any} */ x) => x.show.id), abandoned: data.abandoned.map((/** @type {any} */ x) => x.show.id) };
  }
  return { ...prev, cards };
}

/**
 * Épisodes « jusqu'ici » encore à voir dans une saison en cache : base (saisons précédentes) + rang dans la saison.
 * @param {{ base: number, data: any }} sc
 * @returns {Map<number, number>} id d'épisode → nombre d'épisodes sortis non vus jusqu'à lui inclus
 */
export function untilCounts(sc) {
  const out = new Map();
  let n = sc.base;
  for (const e of sc.data.episodes) {
    if (e.aired && !e.watchedAt) n++;
    out.set(e.id, n);
  }
  return out;
}

/** Cache d'une saison reçue du serveur. @param {any} data réponse GET /api/shows/:id/seasons/:n */
export function seasonEntry(data) {
  const first = data.episodes[0];
  const base = first ? first.untilCount - (first.aired && !first.watchedAt ? 1 : 0) : 0;
  return { data, base };
}
