import type { Context } from 'hono';
import { AppError, InvalidInputError } from '../usecases/context.ts';

// Validation stricte des entrées HTTP. Toute erreur lève InvalidInputError (→ 400).

// Entier positif écrit en décimal (paramètre de chemin ou de requête).
export function positiveId(raw: string | undefined, field: string): number {
  const n = raw !== undefined && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) throw new InvalidInputError(field);
  return n;
}

// Entier positif dans un corps JSON (nombre, pas chaîne).
export function jsonId(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) throw new InvalidInputError(field);
  return raw;
}

// Taille max d'un lot (ids ou entrées à restaurer) : couvre l'annulation d'un « tout vu jusqu'ici » sur une très longue série.
export const MAX_BATCH = 10_000;
// Corps de requête max : un lot de MAX_BATCH entrées à restaurer pèse environ 650 Ko.
export const MAX_BODY_BYTES = 1024 * 1024;

export function idList(raw: unknown, field: string, max = MAX_BATCH): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) throw new InvalidInputError(field);
  return raw.map((x: unknown) => jsonId(x, field));
}

export function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) throw new InvalidInputError(field);
  return raw as T;
}

export function intOneOf<T extends number>(raw: unknown, allowed: readonly T[], field: string): T {
  if (typeof raw !== 'number' || !(allowed as readonly number[]).includes(raw)) throw new InvalidInputError(field);
  return raw as T;
}

// Entier dans [min, max] (corps JSON : nombre, pas chaîne).
export function intRange(raw: unknown, min: number, max: number, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) throw new InvalidInputError(field);
  return raw;
}

export function bool(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') throw new InvalidInputError(field);
  return raw;
}

// Marge acceptée pour un instant fourni par le client : les dates d'un lot vont jusqu'à now + n ms.
const FUTURE_SLACK_MS = 5 * 60_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// Instant ISO 8601 avec fuseau, pas dans le futur ; renvoyé normalisé en UTC.
export function instant(raw: unknown, field: string, now: Date): string {
  if (typeof raw !== 'string' || !ISO_INSTANT.test(raw)) throw new InvalidInputError(field);
  const t = Date.parse(raw);
  if (Number.isNaN(t) || t > now.getTime() + FUTURE_SLACK_MS) throw new InvalidInputError(field);
  return new Date(t).toISOString();
}

// Corps JSON objet obligatoire sur les écritures (Content-Type application/json : protège aussi des formulaires d'autres sites).
export async function jsonBody(c: Context, allowedKeys: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) throw new AppError('json_required', 'corps JSON requis');
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw new AppError('invalid_json', 'JSON invalide');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AppError('invalid_json', 'objet JSON attendu');
  for (const key of Object.keys(body)) if (!allowedKeys.includes(key)) throw new InvalidInputError(key);
  return body as Record<string, unknown>;
}

// Chaîne dans un corps JSON, longueur bornée (les règles métier sont vérifiées plus loin).
export function str(raw: unknown, field: string, max = 1000): string {
  if (typeof raw !== 'string' || raw.length > max) throw new InvalidInputError(field);
  return raw;
}

// Écriture sans paramètre : corps absent, ou objet JSON vide.
export async function noBody(c: Context): Promise<void> {
  if (c.req.header('content-type') === undefined && (await c.req.text()) === '') return;
  await jsonBody(c, []);
}
