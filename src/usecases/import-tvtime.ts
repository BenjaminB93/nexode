import { type Db, transaction } from '../db/index.ts';
import type { TvTimeExport, TvTimeWatch } from '../domain/tvtime.ts';
import { getUserShowsFor, insertUserShow, putWatched } from '../infra/repos.ts';
import type { Tmdb } from '../infra/tmdb.ts';
import type { Catalog } from '../ports.ts';

// Import TV Time : séries retrouvées par leur id TheTVDB (TMDB /find), épisodes par (saison, numéro),
// repli sur l'id TheTVDB de l'épisode quand la numérotation diffère. Idempotent : un épisode déjà vu garde sa date,
// une série déjà dans « mes séries » garde son état. dryRun : rien n'est écrit pour l'utilisateur
// (le cache du catalogue, commun à tous, se remplit quand même).

export type ImportDeps = { db: Db; catalog: Catalog; tmdb: Tmdb; log?: (message: string) => void };

export type ImportReport = {
  shows: { found: number; missing: { tvdbId: number; name: string }[] };
  episodes: { imported: number; alreadySeen: number; missing: { show: string; season: number; number: number }[] };
  relations: { followed: number; shelved: number; kept: number };
};

type FindResult = {
  tv_results?: { id: number }[];
  tv_episode_results?: { show_id: number; season_number: number; episode_number: number }[];
};

export async function importTvTime(deps: ImportDeps, userId: number, data: TvTimeExport, opts: { dryRun?: boolean } = {}): Promise<ImportReport> {
  const { db, catalog, tmdb } = deps;
  const log = deps.log ?? (() => {});
  const report: ImportReport = {
    shows: { found: 0, missing: [] },
    episodes: { imported: 0, alreadySeen: 0, missing: [] },
    relations: { followed: 0, shelved: 0, kept: 0 },
  };

  // 1. Séries : id TheTVDB → id TMDB, puis catalogue local à jour.
  const names = new Map<number, string>();
  for (const w of data.watches) names.set(w.tvdbShowId, w.showName);
  for (const s of data.series) if (!names.has(s.tvdbShowId) || s.name) names.set(s.tvdbShowId, s.name);
  const tmdbIdOf = new Map<number, number>();
  let n = 0;
  for (const [tvdbId, name] of names) {
    n++;
    try {
      const cached = db.prepare('SELECT id FROM shows WHERE tvdb_id = ?').get(tvdbId) as { id: number } | undefined;
      const id = cached?.id ?? (await tmdb.get<FindResult>(`/find/${tvdbId}`, { external_source: 'tvdb_id' })).tv_results?.[0]?.id;
      if (id === undefined) throw new Error('inconnue de TMDB');
      await catalog.ensureShow(id);
      tmdbIdOf.set(tvdbId, id);
      report.shows.found++;
    } catch (err) {
      report.shows.missing.push({ tvdbId, name });
      log(`série « ${name} » (TheTVDB ${tvdbId}) non retrouvée : ${err instanceof Error ? err.message : String(err)}`);
    }
    if (n % 20 === 0) log(`${n}/${names.size} séries…`);
  }

  // 2. Épisodes : position (saison, numéro) chez TMDB, sinon id TheTVDB de l'épisode.
  const byPosition = db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season = ? AND number = ? AND removed_at IS NULL');
  const resolved: { episodeId: number; watchedAt: string }[] = [];
  const missing = (w: TvTimeWatch) => report.episodes.missing.push({ show: w.showName, season: w.season, number: w.number });
  for (const w of data.watches) {
    const showId = tmdbIdOf.get(w.tvdbShowId);
    if (showId === undefined) { missing(w); continue; }
    let row = byPosition.get(showId, w.season, w.number) as { id: number } | undefined;
    if (!row && w.tvdbEpisodeId !== null) {
      try {
        const ep = (await tmdb.get<FindResult>(`/find/${w.tvdbEpisodeId}`, { external_source: 'tvdb_id' })).tv_episode_results?.[0];
        if (ep && ep.show_id === showId) row = byPosition.get(showId, ep.season_number, ep.episode_number) as { id: number } | undefined;
      } catch { /* compté comme non retrouvé */ }
    }
    if (row) resolved.push({ episodeId: row.id, watchedAt: w.watchedAt });
    else missing(w);
  }

  // 3. Écriture, en une transaction.
  const seenBefore = new Set((db.prepare('SELECT episode_id AS id FROM watched WHERE user_id = ?').all(userId) as { id: number }[]).map((r) => r.id));
  const existing = new Set(getUserShowsFor(db, userId, [...tmdbIdOf.values()]).map((r) => r.showId));
  const write = () => {
    for (const r of resolved) {
      if (seenBefore.has(r.episodeId)) { report.episodes.alreadySeen++; continue; }
      seenBefore.add(r.episodeId);
      if (!opts.dryRun) putWatched(db, userId, r.episodeId, r.watchedAt, false);
      report.episodes.imported++;
    }
    for (const s of data.series) {
      const showId = tmdbIdOf.get(s.tvdbShowId);
      if (showId === undefined || (!s.followed && !s.shelved)) continue;
      if (existing.has(showId)) { report.relations.kept++; continue; }
      existing.add(showId);
      const firstWatch = data.watches.find((w) => w.tvdbShowId === s.tvdbShowId)?.watchedAt;
      if (!opts.dryRun) insertUserShow(db, userId, showId, s.shelved ? 'shelved' : 'followed', s.addedAt ?? firstWatch ?? new Date().toISOString());
      if (s.shelved) report.relations.shelved++; else report.relations.followed++;
    }
  };
  if (opts.dryRun) write(); else transaction(db, write);
  return report;
}
