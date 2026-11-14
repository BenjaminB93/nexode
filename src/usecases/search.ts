import { getSeasonCounts } from '../infra/repos.ts';
import type { SearchResult } from '../ports.ts';
import { type Ctx, AppError, UpstreamError } from './context.ts';
import { loadShows, seriesRow } from './state.ts';

// Recherche TMDB ; une série déjà en cache est enrichie (relation, x/y vus, saisons, statut), sinon ces champs sont null.
export async function search(ctx: Ctx, query: string) {
  let results: SearchResult[];
  try {
    results = await ctx.catalog.searchShows(query);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new UpstreamError(`recherche indisponible : ${(err as Error).message}`);
  }
  const ids = results.map((r) => r.id);
  const loaded = loadShows(ctx, ids);
  const counts = getSeasonCounts(ctx.db, ids);
  return results.map((r) => {
    const s = loaded.get(r.id);
    if (s) return { ...seriesRow(s, counts.get(r.id) ?? 0), cached: true };
    return {
      id: r.id, name: r.name, posterPath: r.posterPath, year: r.year,
      seasonCount: null, statusLabel: null, seen: null, total: null, relation: 'none' as const, status: null, cached: false,
    };
  });
}
