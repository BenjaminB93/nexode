// @ts-check
// Notifications de cet appareil : permission du navigateur, abonnement du service worker (/sw.js), enregistrement serveur.
// L'activation est propre à l'appareil ; l'heure d'envoi est un réglage du compte (/api/me).
import { api } from './api.js';

/**
 * État de l'appareil :
 * 'unsupported' (navigateur sans Web Push), 'install' (iPhone hors écran d'accueil : Web Push indisponible dans Safari),
 * 'unavailable' (serveur sans clés VAPID), 'denied' (refusées dans les réglages), 'off', 'on'.
 * @typedef {'unsupported' | 'install' | 'unavailable' | 'denied' | 'off' | 'on'} PushState
 */

const OWNER_KEY = 'pushUser';     // compte pour lequel l'abonnement de l'appareil a été fait
const ASKED_KEY = 'pushAsked';    // la fenêtre « Notifications ? » a déjà été montrée sur cet appareil

/** @param {string} k */
function readLocal(k) { try { return localStorage.getItem(k); } catch { return null; } }
/** @param {string} k @param {string | null} v */
function writeLocal(k, v) {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* navigation privée */ }
}

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;
}

/** Enregistre le service worker (au démarrage). */
export function registerWorker() {
  if (!pushSupported()) return;
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker non enregistré', e));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** @param {string} b64 base64url @returns {Uint8Array<ArrayBuffer>} */
function bytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Abonnement fait avec cette clé serveur (sinon : clés VAPID changées, à refaire). @param {PushSubscription} sub @param {string} key */
function sameKey(sub, key) {
  const k = sub.options && sub.options.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k), b = bytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Clé publique du serveur ; null si les notifications n'y sont pas configurées. */
async function serverKey() {
  try {
    return (await api.pushKey()).publicKey;
  } catch (e) {
    if (e && /** @type {any} */ (e).code === 'push_unavailable') return null;
    throw e;
  }
}

/**
 * Au démarrage, session ouverte : état de l'appareil, abonnement rattaché à la session courante (requête idempotente).
 * Un abonnement fait pour un autre compte sur cet appareil est abandonné (le nouveau compte décidera lui-même).
 * @param {string} username @returns {Promise<PushState>}
 */
export async function syncPush(username) {
  if (!pushSupported()) return isIos() && !standalone() ? 'install' : 'unsupported';
  const key = await serverKey();
  if (key === null) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await currentSubscription();
  if (!sub) return 'off';
  if (Notification.permission !== 'granted' || readLocal(OWNER_KEY) !== username || !sameKey(sub, key)) {
    await sub.unsubscribe().catch(() => {});
    writeLocal(OWNER_KEY, null);
    return 'off';
  }
  await api.pushSubscribe(sub.toJSON());
  return 'on';
}

/**
 * Activation : à appeler directement depuis le geste (tap), la demande de permission doit en partir.
 * @param {string} username @returns {Promise<PushState>}
 */
export async function enablePush(username) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const key = await serverKey();
  if (key === null) return 'unavailable';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  await api.pushSubscribe(sub.toJSON());
  writeLocal(OWNER_KEY, username);
  return 'on';
}

/** Désactivation sur cet appareil. @returns {Promise<PushState>} */
export async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe();
  }
  writeLocal(OWNER_KEY, null);
  return 'off';
}

/** Déconnexion : l'appareil cesse de recevoir (côté serveur, la session fermée emporte l'abonnement) ; le compte suivant sera interrogé. */
export async function forgetPush() {
  writeLocal(OWNER_KEY, null);
  writeLocal(ASKED_KEY, null);
  if (!pushSupported()) return;
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
}

/** Notification de test vers cet appareil : 'sent' | 'gone' | 'failed'. */
export async function testPush() {
  const sub = await currentSubscription();
  if (!sub) return 'gone';
  return (await api.pushTest(sub.endpoint)).result;
}

/** La fenêtre « Notifications ? » n'est montrée qu'une fois par appareil (et par connexion). */
export function shouldAsk() { return readLocal(ASKED_KEY) === null; }
export function markAsked() { writeLocal(ASKED_KEY, '1'); }
export function permissionUndecided() { return pushSupported() && Notification.permission === 'default'; }

/**
 * Cible d'une notification touchée, transmise par le service worker (adresse /?ep=… à l'ouverture, ou message).
 * @param {URLSearchParams | Record<string, unknown>} src
 * @returns {{ show: number, name: string, season: number, number: number, ep: number } | null}
 */
export function notifTarget(src) {
  const get = (/** @type {string} */ k) => (src instanceof URLSearchParams ? src.get(k) : src[k]);
  const n = (/** @type {string} */ k) => {
    const v = Number(get(k));
    return Number.isInteger(v) && v >= 0 ? v : null;
  };
  const show = n('show'), season = n('season'), number = n('number'), ep = n('ep');
  if (!show || season === null || number === null || !ep) return null;
  const name = get('name');
  return { show, name: typeof name === 'string' ? name : '', season, number, ep };
}
