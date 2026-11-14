// Règles des comptes : rôles, noms, mots de passe, durées de validité, statut d'une invitation.

export const ROLES = ['membre', 'parrain', 'admin'] as const;
export type Role = (typeof ROLES)[number];
// Rôles qu'un admin peut attribuer (l'admin se crée en ligne de commande).
export const ASSIGNABLE_ROLES = ['membre', 'parrain'] as const;

export const canInvite = (role: Role) => role === 'parrain' || role === 'admin';

const DAY_MS = 86_400_000;
export const SESSION_TTL_MS = 180 * DAY_MS;
export const SESSION_TOUCH_MS = DAY_MS;          // prolongation de session au plus une fois par jour
export const INVITE_TTL_MS = 7 * DAY_MS;
export const RESET_TTL_MS = DAY_MS;

export const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

// 3 à 24 caractères : lettres (accents compris), chiffres, « _ », « - », « . ». Renvoie le nom en NFC, ou null.
const USERNAME = /^[\p{L}0-9_.-]{3,24}$/u;
export function normalizeUsername(raw: string): string | null {
  const s = raw.normalize('NFC');
  return USERNAME.test(s) ? s : null;
}

// Clé d'unicité : insensible à la casse, accents compris.
export const usernameKey = (name: string) => name.normalize('NFC').toLowerCase();

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
// Longueur en caractères (points de code), aucune autre règle.
export function passwordLengthOk(pw: string): boolean {
  const n = [...pw].length;
  return n >= PASSWORD_MIN && n <= PASSWORD_MAX;
}

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';
export function inviteStatus(i: { usedAt: string | null; revokedAt: string | null; expiresAt: string }, nowIso: string): InviteStatus {
  if (i.usedAt) return 'used';
  if (i.revokedAt) return 'revoked';
  return i.expiresAt <= nowIso ? 'expired' : 'pending';
}
