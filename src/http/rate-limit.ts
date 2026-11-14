import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AppError } from '../usecases/context.ts';

// Limitation des échecs (connexion, codes d'invitation, liens de réinitialisation), en mémoire : perdue au redémarrage.

export class TooManyAttemptsError extends AppError {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super('too_many_attempts', 'trop de tentatives', { retryAfter });
    this.retryAfter = retryAfter;
  }
}

// max échecs dans une fenêtre glissante de windowMs. Les instants sont en ms (horloge injectable pour les tests).
export class FailureLimiter {
  readonly max: number;
  readonly windowMs: number;
  #fails = new Map<string, number[]>();
  #lastPurge = 0;

  constructor(max = 5, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  #recent(key: string, now: number): number[] {
    return (this.#fails.get(key) ?? []).filter((t) => t > now - this.windowMs);
  }

  // Secondes avant la prochaine tentative permise ; 0 = permise.
  retryAfter(key: string, now: number): number {
    this.#purge(now);
    const fails = this.#recent(key, now);
    if (fails.length < this.max) return 0;
    return Math.max(1, Math.ceil(((fails[fails.length - this.max] as number) + this.windowMs - now) / 1000));
  }

  fail(key: string, now: number): void {
    const fails = this.#recent(key, now);
    fails.push(now);
    this.#fails.set(key, fails.slice(-this.max));
  }

  // Retire un échec compté à l'instant t (tentative réservée qui n'a finalement pas échoué).
  forget(key: string, t: number): void {
    const fails = this.#fails.get(key);
    const i = fails?.indexOf(t) ?? -1;
    if (!fails || i < 0) return;
    fails.splice(i, 1);
    if (!fails.length) this.#fails.delete(key);
  }

  reset(key: string): void {
    this.#fails.delete(key);
  }

  get size(): number {
    return this.#fails.size;
  }

  // Au plus une fois par minute : retire les clés dont le dernier échec est sorti de la fenêtre.
  #purge(now: number): void {
    if (now - this.#lastPurge < 60_000) return;
    this.#lastPurge = now;
    for (const [key, fails] of this.#fails) if ((fails[fails.length - 1] ?? 0) <= now - this.windowMs) this.#fails.delete(key);
  }
}

// Lève TooManyAttemptsError si une des clés est bloquée (attente la plus longue).
export function guard(checks: readonly [FailureLimiter, string][], now: number): void {
  const wait = Math.max(0, ...checks.map(([limiter, key]) => limiter.retryAfter(key, now)));
  if (wait > 0) throw new TooManyAttemptsError(wait);
}

// Exécute fn ; si elle lève une des erreurs codes, l'échec compte pour chaque clé.
// L'échec est compté avant fn (scrypt asynchrone), sinon des requêtes parallèles passeraient toutes le contrôle ;
// il est retiré si fn réussit ou échoue pour une autre raison.
export async function counting<T>(checks: readonly [FailureLimiter, string][], now: number, codes: readonly string[], fn: () => Promise<T> | T): Promise<T> {
  guard(checks, now);
  for (const [limiter, key] of checks) limiter.fail(key, now);
  const release = () => { for (const [limiter, key] of checks) limiter.forget(key, now); };
  try {
    const result = await fn();
    release();
    return result;
  } catch (err) {
    if (!(err instanceof AppError && codes.includes(err.code))) release();
    throw err;
  }
}

// Adresse du client. Derrière Caddy (trustProxy), Caddy ajoute l'adresse vue en dernier dans X-Forwarded-For.
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'inconnue';
  } catch {
    return 'inconnue';   // pas de socket (app.request dans les tests)
  }
}
