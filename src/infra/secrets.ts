import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Mots de passe (scrypt) et jetons aléatoires. Seul le SHA-256 d'un jeton est stocké.

// Format : scrypt$N$r$p$sel$clé (base64url) ; les paramètres sont relus au contrôle et peuvent donc évoluer.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAX_MEM = 64 * 1024 * 1024;

// Un calcul prend 16 Mo et ~100 ms d'un thread du pool libuv (4 threads, partagé avec les accès fichiers).
// Au plus HASH_MAX_ACTIVE en parallèle et HASH_MAX_WAITING en attente ; au-delà, refus immédiat sans calcul.
export const HASH_MAX_ACTIVE = 2;
export const HASH_MAX_WAITING = 16;
let active = 0;
const waiting: (() => void)[] = [];

export class HashBusyError extends Error {
  constructor() { super('trop de calculs de mot de passe en attente'); }
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < HASH_MAX_ACTIVE) active++;
  else if (waiting.length < HASH_MAX_WAITING) await new Promise<void>((resolve) => waiting.push(resolve));
  else throw new HashBusyError();
  try {
    return await fn();
  } finally {
    const next = waiting.shift();   // la place passe directement au suivant
    if (next) next();
    else active--;
  }
}

function derive(password: string, salt: Buffer, keyLen: number, n: number, r: number, p: number): Promise<Buffer> {
  return withSlot(() => new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, keyLen, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  }));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, KEY_LEN, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/;
// Hachage factice (clé aléatoire, jamais retrouvée) : même coût pour un compte absent ou sans mot de passe.
const DUMMY = STORED.exec(`scrypt$${N}$${R}$${P}$${randomBytes(SALT_LEN).toString('base64url')}$${randomBytes(KEY_LEN).toString('base64url')}`) as RegExpExecArray;

// Faux si le hachage est inutilisable ('!') ou mal formé. Le calcul a toujours lieu, pour un temps de réponse constant.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const real = STORED.exec(stored);
  const m = real ?? DUMMY;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const expected = Buffer.from(m[5] as string, 'base64url');
  const key = await derive(password, Buffer.from(m[4] as string, 'base64url'), expected.length, n, r, p);
  return timingSafeEqual(key, expected) && real !== null;
}

// Jeton aléatoire en base64url : 16 octets (128 bits) → 22 caractères, 32 octets (256 bits) → 43.
export const newToken = (bytes: 16 | 32) => randomBytes(bytes).toString('base64url');
export const tokenShape = (bytes: 16 | 32) => new RegExp(`^[A-Za-z0-9_-]{${bytes === 16 ? 22 : 43}}$`);
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
