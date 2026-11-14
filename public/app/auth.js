// @ts-check
// Règles pures des comptes (aucun DOM, aucun réseau) : pages ouvertes par un lien, saisie des formulaires,
// messages d'erreur, rôles, liens d'invitation.

/** Nom d'utilisateur : 3 à 24 lettres (accents compris), chiffres 0-9, « _ », « - », « . » ; même règle que src/domain/accounts.ts. */
const USERNAME_RE = /^[\p{L}0-9_.-]{3,24}$/u;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const NAME_RULE = '3 à 24 caractères : lettres, chiffres, _ - .';

/**
 * Page hors appli ouverte par un lien (le serveur sert index.html pour ces chemins).
 * @param {string} path
 * @returns {{ screen: 'signup', code: string } | { screen: 'reset', token: string } | null}
 */
export function parseAuthRoute(path) {
  const m = /^\/(invitation|reinitialisation)\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  let v;
  try { v = decodeURIComponent(/** @type {string} */ (m[2])); } catch { return null; }
  return m[1] === 'invitation' ? { screen: 'signup', code: v } : { screen: 'reset', token: v };
}

/** Nom tel qu'il est envoyé : sans espaces autour, en NFC (un « é » tapé en deux caractères devient un seul). @param {string} s */
export const cleanName = (s) => s.trim().normalize('NFC');

/** @param {string} name nom nettoyé */
export const nameOk = (name) => USERNAME_RE.test(name);

/**
 * Problème à signaler pendant la saisie du nom. Trop court : rien (le bouton reste inactif), pour ne pas crier dès la 1re lettre.
 * @param {string} name nom nettoyé @returns {string | null}
 */
export function nameProblem(name) {
  if (!name || nameOk(name)) return null;
  return [...name].length < 3 && /^[\p{L}0-9_.-]*$/u.test(name) ? null : NAME_RULE;
}

/** Longueur en caractères (points de code) comme le serveur : un emoji compte pour un. @param {string} pw */
export const passwordLength = (pw) => [...pw].length;

/** @param {string} pw */
export function passwordOk(pw) {
  const n = passwordLength(pw);
  return n >= PASSWORD_MIN && n <= PASSWORD_MAX;
}

/** @param {number | undefined} seconds */
function waitText(seconds) {
  const m = Math.max(1, Math.ceil((seconds || 60) / 60));
  return m + ' min';
}

/**
 * Message affiché sous un formulaire de compte pour une erreur d'API.
 * @param {any} e ApiError (status, code, field, retryAfter) ou autre
 */
export function authErrorText(e) {
  switch (e && e.code) {
    case 'invalid_credentials': return 'Nom d’utilisateur ou mot de passe incorrect';
    case 'too_many_attempts': return 'Trop de tentatives : réessaie dans ' + waitText(e.retryAfter);
    case 'username_taken': return 'Ce nom est déjà pris';
    case 'invalid_input':
      if (e.field === 'username') return NAME_RULE;
      if (e.field === 'password') return 'Mot de passe : ' + PASSWORD_MIN + ' à ' + PASSWORD_MAX + ' caractères';
      return 'Saisie invalide';
    case 'wrong_password': return 'Mot de passe incorrect';
    case 'last_admin': return 'Dernier compte admin : suppression impossible';
    case 'network': return 'Serveur injoignable';
    default: return 'Erreur du serveur';
  }
}

/** Champ à entourer de rouge pour une erreur d'API. @param {any} e @returns {'name' | 'password' | null} */
export function authErrorField(e) {
  if (!e) return null;
  if (e.code === 'username_taken' || (e.code === 'invalid_input' && e.field === 'username')) return 'name';
  if (e.code === 'wrong_password' || (e.code === 'invalid_input' && e.field === 'password')) return 'password';
  return null;
}

/** @param {string | null | undefined} role */
export const canInvite = (role) => role === 'parrain' || role === 'admin';

/**
 * Liens d'invitation par section (l'ordre du serveur, du plus récent au plus ancien, est conservé).
 * @template {{ status: string }} T @param {T[]} invites
 */
export function inviteGroups(invites) {
  return {
    pending: invites.filter((x) => x.status === 'pending'),
    used: invites.filter((x) => x.status === 'used'),
    dead: invites.filter((x) => x.status === 'expired' || x.status === 'revoked'),
  };
}

/** Nom du fichier téléchargé, d'après l'en-tête Content-Disposition. @param {string | null} cd @param {string} fallback */
export function fileNameFrom(cd, fallback) {
  const m = cd ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd) : null;
  if (!m) return fallback;
  try { return decodeURIComponent(/** @type {string} */ (m[1])); } catch { return /** @type {string} */ (m[1]); }
}
