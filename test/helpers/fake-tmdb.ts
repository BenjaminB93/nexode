// Faux TMDB pour les tests : sert les réponses enregistrées dans test/fixtures/tmdb/ selon l'URL, sans réseau.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'tmdb');

// Clé d'une requête : chemin sans le préfixe /3, paramètres triés. Ex. '/tv/100088?append_to_response=external_ids&language=fr-FR'.
export function requestKey(input: string | URL): string {
  const url = new URL(input);
  const params = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b));
  const query = new URLSearchParams(params).toString();
  return url.pathname.replace(/^\/3/, '') + (query ? `?${decodeURIComponent(query)}` : '');
}

// Toutes les fixtures, clé → corps JSON (copie neuve à chaque appel, modifiable par le test).
export function loadFixtures(): Map<string, unknown> {
  const routes = new Map<string, unknown>();
  for (const f of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))) {
    const { url, body } = JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as { url: string; body: unknown };
    routes.set(url, body);
  }
  return routes;
}

export type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> };

// Une valeur de routes est soit un corps JSON (200), soit une fonction qui décide de la réponse.
export function fakeFetch(routes: Map<string, unknown>): { fetch: typeof globalThis.fetch; requests: { key: string; headers: Headers }[] } {
  const requests: { key: string; headers: Headers }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const key = requestKey(input instanceof Request ? input.url : input);
    requests.push({ key, headers: new Headers(init?.headers) });
    const route = routes.get(key);
    const reply: FakeReply =
      route === undefined
        ? { status: 404, body: { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' } }
        : typeof route === 'function'
          ? (route as () => FakeReply)()
          : { status: 200, body: route };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
