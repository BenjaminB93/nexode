// @ts-check
// Accès à l'API JSON (/api). Toute erreur est une ApiError : status 0 = réseau injoignable.
import { fileNameFrom } from './auth.js';

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} [field] @param {number} [retryAfter] secondes (429) */
  constructor(status, code, field, retryAfter) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
    this.retryAfter = retryAfter;
  }
}

/** Requête annulée (recherche périmée) : à ignorer, jamais affichée. @param {unknown} e */
export const isAbort = (e) => e instanceof DOMException && e.name === 'AbortError';

/** @type {(() => void) | null} */
let unauthorized = null;
// Change à chaque ouverture ou fermeture de session : un 401 d'une requête partie avant n'est pas signalé.
let sessionGen = 0;

/** Appelé quand une route protégée répond 401 (session expirée ou supprimée). @param {(() => void) | null} fn */
export function onUnauthorized(fn) { unauthorized = fn; }

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]  présent = corps JSON (obligatoire côté serveur sur les écritures)
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
async function send(method, path, body, signal) {
  /** @type {RequestInit} */
  const init = { method, cache: 'no-store', credentials: 'same-origin', signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const gen = sessionGen;
  let res;
  try {
    res = await fetch('/api' + path, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError(0, 'network');
  }
  if (res.status === 401 && gen === sessionGen && !path.startsWith('/auth/') && unauthorized) unauthorized();
  return res;
}

/** @param {Response} res */
async function errorOf(res) {
  let data = null;
  try { data = await res.json(); } catch { /* corps vide ou non JSON */ }
  return new ApiError(res.status, (data && data.error) || 'http_' + res.status, data && data.field, data && data.retryAfter);
}

/** @param {string} method @param {string} path @param {unknown} [body] @param {AbortSignal} [signal] @returns {Promise<any>} */
async function call(method, path, body, signal) {
  const res = await send(method, path, body, signal);
  if (!res.ok) throw await errorOf(res);
  try { return await res.json(); } catch { return null; }
}

/** Ouverture ou fermeture de session réussie. @template T @param {Promise<T>} p */
const session = (p) => p.then((r) => { sessionGen++; return r; });

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

  // Authentification (sans session) : un 401 y est une réponse normale, pas une fin de session.
  /** @param {string} username @param {string} password */
  login: (username, password) => session(call('POST', '/auth/login', { username, password })),
  logout: () => session(call('POST', '/auth/logout', {})),
  /** @param {string} code */
  invite: (code) => call('GET', '/auth/invite/' + seg(code)),
  /** @param {string} code @param {string} username @param {string} password */
  signup: (code, username, password) => session(call('POST', '/auth/signup', { code, username, password })),
  /** @param {string} token */
  resetInfo: (token) => call('GET', '/auth/reset/' + seg(token)),
  /** @param {string} token @param {string} password */
  reset: (token, password) => session(call('POST', '/auth/reset', { token, password })),

  // Mon compte
  /** @param {string} password */
  deleteMe: (password) => session(call('DELETE', '/me', { password })),
  /** Export RGPD : texte JSON et nom de fichier proposé par le serveur. @param {string} fallbackName */
  exportMe: async (fallbackName) => {
    const res = await send('GET', '/me/export');
    if (!res.ok) throw await errorOf(res);
    return { text: await res.text(), filename: fileNameFrom(res.headers.get('Content-Disposition'), fallbackName) };
  },

  // Parrainages (parrain, admin)
  invites: () => call('GET', '/invites'),
  createInvite: () => call('POST', '/invites', {}),
  /** @param {number} id */
  revokeInvite: (id) => call('DELETE', '/invites/' + seg(id), {}),

  // Comptes (admin)
  users: () => call('GET', '/admin/users'),
  /** @param {number} id @param {'membre' | 'parrain'} role */
  setUserRole: (id, role) => call('PUT', '/admin/users/' + seg(id) + '/role', { role }),
  /** @param {number} id */
  resetLink: (id) => call('POST', '/admin/users/' + seg(id) + '/reset', {}),
  /** @param {number} id */
  deleteUser: (id) => call('DELETE', '/admin/users/' + seg(id), {}),
};
