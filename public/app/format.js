// @ts-check
// Formats, libellés et règles d'affichage purs (aucun accès au DOM ni au réseau).
// Jours calendaires en 'YYYY-MM-DD'. « Aujourd'hui » est toujours fourni par l'appelant (jour du serveur, fuseau de l'utilisateur).

const DAY_MS = 86400000;

/** @param {string} s */
function toD(s) { return new Date(s + 'T12:00:00Z'); }

/** Jours calendaires de a à b (négatif si b est avant a). @param {string} a @param {string} b */
function daysBetween(a, b) { return Math.round((toD(b).getTime() - toD(a).getTime()) / DAY_MS); }

const F_DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const F_DAY_Y = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const F_SHORT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const F_SHORT_Y = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** @param {string} s */
export function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
/** « ven. 13 nov. » (année ajoutée si ce n'est pas celle d'aujourd'hui). @param {string} s @param {string} today */
export function fDay(s, today) { return (s.slice(0, 4) === today.slice(0, 4) ? F_DAY : F_DAY_Y).format(toD(s)); }
/** « 13 nov. » @param {string} s @param {string} today */
export function fShort(s, today) { return (s.slice(0, 4) === today.slice(0, 4) ? F_SHORT : F_SHORT_Y).format(toD(s)); }

/** @param {string} s @param {string} today */
export function ago(s, today) {
  const n = daysBetween(s, today);
  if (n <= 0) return 'aujourd’hui';
  if (n === 1) return 'hier';
  if (n < 14) return 'il y a ' + n + ' jours';
  if (n < 60) return 'il y a ' + Math.round(n / 7) + ' semaines';
  if (n < 365) return 'il y a ' + Math.round(n / 30) + ' mois';
  const y = Math.round(n / 365);
  return 'il y a ' + y + (y > 1 ? ' ans' : ' an');
}

/** @param {string} s @param {string} today */
export function inDays(s, today) {
  const n = daysBetween(today, s);
  if (n <= 0) return 'aujourd’hui';
  if (n === 1) return 'demain';
  if (n < 60) return 'dans ' + n + ' jours';
  return 'dans ' + Math.round(n / 30) + ' mois';
}

/** Libellé de jour d'un groupe de l'historique. @param {string} day @param {string} today */
export function dayLabel(day, today) {
  const n = daysBetween(day, today);
  return n === 0 ? 'Aujourd’hui' : n === 1 ? 'Hier · ' + fDay(day, today) : cap(fDay(day, today));
}

/** @param {number} s @param {number} e */
export function code(s, e) { return 'S' + s + 'E' + e; }
/** @param {number} n @param {string} one @param {string} many */
export function plural(n, one, many) { return n + ' ' + (n > 1 ? many : one); }

/** @param {{ title: string | null }} ep */
export function epTitle(ep) { return ep.title || 'Titre pas encore annoncé'; }

/** @param {{ season: number, number: number }} a @param {{ season: number, number: number }} b */
export function compareEp(a, b) { return a.season - b.season || a.number - b.number; }

/** @type {Map<string, Intl.DateTimeFormat>} */
const tzFormats = new Map();
/** Jour local d'un instant ISO dans un fuseau IANA. @param {string} instant @param {string} timezone */
export function localDay(instant, timezone) {
  let f = tzFormats.get(timezone);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
    tzFormats.set(timezone, f);
  }
  const parts = f.formatToParts(new Date(instant));
  /** @param {string} t */
  const part = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return part('year') + '-' + part('month') + '-' + part('day');
}

/** @param {string | null | undefined} p */
export const posterUrl = (p) => (p ? 'https://image.tmdb.org/t/p/w185' + p : null);
/** @param {string | null | undefined} p */
export const logoUrl = (p) => (p ? 'https://image.tmdb.org/t/p/w92' + p : null);

/** Sous-titre série « année · N saisons · statut ». @param {{ year: number | null, seasonCount: number | null, statusLabel: string | null }} s */
export function showMeta(s) {
  const parts = [];
  if (s.year) parts.push(String(s.year));
  if (s.seasonCount != null) parts.push(plural(s.seasonCount, 'saison', 'saisons'));
  if (s.statusLabel) parts.push(s.statusLabel);
  return parts.join(' · ');
}

// État d'une série : [libellé, fond, texte].
/** @type {Record<string, [string, string, string]>} */
export const CHIPS = {
  encours: ['En cours', 'var(--accent-bg)', 'var(--accent)'],
  ajour: ['À jour', 'var(--ok-bg)', 'var(--ok-fg)'],
  decote: ['De côté', 'var(--chip)', 'var(--soft)'],
  terminee: ['Terminée', 'var(--chip2)', 'var(--muted)'],
};

export const THEMES = [{ v: 'system', l: 'Système' }, { v: 'light', l: 'Clair' }, { v: 'dark', l: 'Sombre' }];
export const COUNTRIES = [{ v: 'FR', l: 'France' }, { v: 'BE', l: 'Belgique' }, { v: 'CH', l: 'Suisse' }, { v: 'CA', l: 'Canada' }];
export const THRESHOLDS = [{ v: '15', l: '15 jours' }, { v: '30', l: '30 jours' }, { v: '60', l: '2 mois' }, { v: '90', l: '3 mois' }];
export const HOURS = Array.from({ length: 24 }, (_, h) => ({ v: String(h), l: h + ' h' }));

/** @param {string} c */
export function countryName(c) { return (COUNTRIES.find((x) => x.v === c) || { l: c }).l; }
