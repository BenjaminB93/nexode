// @ts-check
// Accès à l'API JSON (/api). Toute erreur est une ApiError : status 0 = réseau injoignable.

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} [field] */
  constructor(status, code, field) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Requête annulée (recherche périmée) : à ignorer, jamais affichée. @param {unknown} e */
export const isAbort = (e) => e instanceof DOMException && e.name === 'AbortError';

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]  présent = corps JSON (obligatoire côté serveur sur les écritures)
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function call(method, path, body, signal) {
  /** @type {RequestInit} */
  const init = { method, cache: 'no-store', credentials: 'same-origin', signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError(0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* corps vide ou non JSON */ }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'http_' + res.status, data && data.field);
  return data;
}

/** @param {number | string} x */
const seg = (x) => encodeURIComponent(String(x));

export const api = {
  me: () => call('GET', '/me'),
  /** @param {{ country?: string, shelveAfterDays?: number, notifOn?: boolean, notifHour?: number }} patch */
  patchMe: (patch) => call('PATCH', '/me', patch),
  timeline: () => call('GET', '/timeline'),
  /** @param {string | null} before curseur opaque renvoyé par la page précédente */
  history: (before) => call('GET', '/history' + (before ? '?before=' + seg(before) : '')),
  shelf: () => call('GET', '/shelf'),
  myShows: () => call('GET', '/my-shows'),
  /** @param {string} q @param {AbortSignal} [signal] */
  search: (q, signal) => call('GET', '/search?q=' + seg(q), undefined, signal),
  /** @param {number} id */
  show: (id) => call('GET', '/shows/' + seg(id)),
  /** @param {number} id @param {number} n */
  season: (id, n) => call('GET', '/shows/' + seg(id) + '/seasons/' + seg(n)),
  /** @param {number} id @param {'none' | 'on' | 'shelf'} to */
  setRelation: (id, to) => call('PUT', '/shows/' + seg(id) + '/relation', { to }),
  /** @param {number} episodeId @param {string} [watchedAt] date imposée (annulation d'une remise en non vu) */
  mark: (episodeId, watchedAt) => call('PUT', '/watched/' + seg(episodeId), watchedAt ? { watchedAt } : {}),
  /** @param {number} episodeId */
  unmark: (episodeId) => call('DELETE', '/watched/' + seg(episodeId)),
  /** @param {{ on: boolean, episodeIds?: number[], restore?: { episodeId: number, watchedAt: string }[] }} body */
  batch: (body) => call('POST', '/watched/batch', body),
  /** @param {number} showId @param {number} episodeId */
  watchedUntil: (showId, episodeId) => call('POST', '/shows/' + seg(showId) + '/watched-until', { episodeId }),
  /** @param {number} showId @param {number} n */
  markSeason: (showId, n) => call('POST', '/shows/' + seg(showId) + '/seasons/' + seg(n) + '/watched', {}),
};
