// Notifications de sortie : une par série et par jour, envoyée à l'heure choisie par l'utilisateur (dans son fuseau).

export type NotifEpisode = { id: number; season: number; number: number; title: string | null };

// Ouvert au toucher : la fiche de l'épisode (le premier du jour pour la série).
export type NotifTarget = { show: number; name: string; season: number; number: number; ep: number };

// Contenu envoyé au service worker (public/sw.js). open null : le toucher ouvre l'appli sur son écran courant.
export type NotifPayload = { title: string; body: string; tag: string; open: NotifTarget | null };

// Heure passée = due : une échéance horaire manquée (redémarrage) est rattrapée dans la journée.
export const isDue = (localHour: number, notifHour: number): boolean => localHour >= notifHour;

const code = (e: NotifEpisode) => `S${e.season}E${e.number}`;

export function notificationFor(show: { id: number; name: string }, episodes: readonly NotifEpisode[]): NotifPayload {
  if (!episodes.length) throw new RangeError(`aucun épisode pour la série ${show.id}`);
  const list = [...episodes].sort((a, b) => a.season - b.season || a.number - b.number);
  const first = list[0]!;
  const body = list.length === 1
    ? `Nouvel épisode : ${code(first)}${first.title ? ` · ${first.title}` : ''}`
    : `${list.length} nouveaux épisodes : ${code(first)} à ${code(list.at(-1)!)}`;
  return {
    title: show.name,
    body,
    tag: `show-${show.id}`,
    open: { show: show.id, name: show.name, season: first.season, number: first.number, ep: first.id },
  };
}

// Heure locale (0-23) d'un instant dans un fuseau IANA.
export function localHour(now: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: 'numeric' }).format(now);
  return Number(h);
}

// Services push des navigateurs (Chrome/Android et dérivés, Safari/iOS, Firefox, Edge). Le serveur poste vers l'endpoint
// fourni par le client : hors de ces domaines, ce serait une requête vers n'importe quelle adresse (réseau interne compris).
const PUSH_HOSTS = ['.googleapis.com', '.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];

export function isPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === ''
    && PUSH_HOSTS.some((h) => `.${url.hostname}`.endsWith(h));
}

// Clés du navigateur (base64url sans remplissage) : p256dh = point P-256 non compressé (65 octets), auth = 16 octets.
export function isPushKeys(p256dh: string, auth: string): boolean {
  const bytes = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? Buffer.from(s, 'base64url') : null);
  const p = bytes(p256dh);
  const a = bytes(auth);
  return p !== null && p.length === 65 && p[0] === 4 && a !== null && a.length === 16;
}
