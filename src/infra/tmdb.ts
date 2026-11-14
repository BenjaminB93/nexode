// Client HTTP TMDB (API v3), authentification par jeton « Read Access Token ».
// Le jeton ne sort jamais de l'en-tête Authorization : ni dans les messages d'erreur, ni dans les logs.

export const TMDB_BASE = 'https://api.themoviedb.org/3';
export const USER_AGENT = 'tv-show-resurection/0.1 (auto-hébergé)';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 30_000;

export type TmdbParams = Record<string, string | number | boolean | undefined>;

export interface Tmdb {
  get<T = unknown>(path: string, params?: TmdbParams): Promise<T>;
  // Nombre de requêtes HTTP émises, nouveaux essais compris.
  calls(): number;
}

export type TmdbDeps = {
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
};

// status 0 = pas de réponse HTTP (réseau, délai dépassé avant les en-têtes).
export class TmdbError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, detail: string) {
    super(`TMDB ${status || 'réseau'} sur ${path} : ${detail}`);
    this.name = 'TmdbError';
    this.status = status;
    this.path = path;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof TmdbError && err.status === 404;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Retry-After en secondes ou en date HTTP ; null si absent ou illisible.
function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export function createTmdb({ token, fetch = globalThis.fetch, sleep = defaultSleep }: TmdbDeps): Tmdb {
  if (!token) throw new Error('Jeton TMDB manquant (TMDB_READ_TOKEN)');
  let count = 0;
  const scrub = (text: string) => text.split(token).join('***');

  async function get<T>(path: string, params: TmdbParams = {}): Promise<T> {
    const url = new URL(TMDB_BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const shown = url.pathname.slice(2) + url.search; // sans le préfixe /3

    for (let attempt = 0; ; attempt++) {
      count++;
      let res: Response | undefined;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) return (await res.json()) as T;
      } catch (err) {
        // Pas de réponse, ou corps d'une réponse 2xx illisible. Délai dépassé : pas de nouvel essai (10 s suffisent).
        const timeout = err instanceof Error && err.name === 'TimeoutError';
        if (!timeout && attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const detail = timeout ? 'délai dépassé' : res ? 'réponse illisible' : err instanceof Error ? err.message : String(err);
        throw new TmdbError(res?.status ?? 0, shown, scrub(detail));
      }

      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < MAX_RETRIES) {
        await res.body?.cancel();
        const wait = retryAfterMs(res.headers.get('retry-after'), Date.now()) ?? 1000 * 2 ** attempt;
        await sleep(Math.min(wait, MAX_WAIT_MS));
        continue;
      }
      let detail = res.statusText || 'erreur';
      try {
        const body = (await res.json()) as { status_message?: unknown };
        if (typeof body.status_message === 'string') detail = body.status_message;
      } catch {
        // corps non JSON : on garde statusText
      }
      throw new TmdbError(res.status, shown, scrub(detail));
    }
  }

  return { get, calls: () => count };
}
