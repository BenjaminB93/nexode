import { type Db, transaction } from '../db/index.ts';
import { type ImportData, type ImportWatch, type ShowRef, normTitle, showKey } from '../domain/imports.ts';
import { getUserShowsFor, insertUserShow, putWatched } from '../infra/repos.ts';
import type { Catalog, SearchResult } from '../ports.ts';

// Import d'un historique venu d'une autre appli (TV Time, BetaSeries).
// Séries : id TheTVDB quand l'export le donne, sinon titre (+ année) : cache local puis recherche TMDB ; entre plusieurs
// séries de même titre (« Doctor Who » 1963 / 2005), celle qui contient le plus d'épisodes vus de l'export.
// Épisodes : position (saison, numéro), repli sur l'id TheTVDB de l'épisode. Plusieurs sources pour un même épisode :
// le plus ancien visionnage. Idempotent : un épisode déjà vu garde sa date, une série déjà dans « mes séries » son état.
// dryRun : rien n'est écrit pour l'utilisateur (le cache du catalogue, commun à tous, se remplit quand même).

export type ImportDeps = { db: Db; catalog: Catalog; log?: (message: string) => void };

export type ImportReport = {
  shows: { found: number; missing: string[]; approximate: { title: string; matched: string }[] };
  episodes: { imported: number; alreadySeen: number; missing: { show: string; season: number; number: number }[] };
  relations: { followed: number; shelved: number; kept: number };
};

const CANDIDATES_MAX = 3;
const KNOWN_RATIO = 0.8;

type Resolved = { showId: number; approximate: string | null };

export async function importHistory(deps: ImportDeps, userId: number, data: ImportData, opts: { dryRun?: boolean } = {}): Promise<ImportReport> {
  const { db, catalog } = deps;
  const log = deps.log ?? (() => {});
  const report: ImportReport = {
    shows: { found: 0, missing: [], approximate: [] },
    episodes: { imported: 0, alreadySeen: 0, missing: [] },
    relations: { followed: 0, shelved: 0, kept: 0 },
  };

  // Séries désignées par l'export, avec les positions vues (pour départager les homonymes).
  const refs = new Map<string, { ref: ShowRef; positions: Set<string> }>();
  const refOf = (ref: ShowRef) => {
    const k = showKey(ref);
    let e = refs.get(k);
    if (!e) refs.set(k, (e = { ref, positions: new Set() }));
    return e;
  };
  for (const w of data.watches) refOf(w.show).positions.add(`${w.season}:${w.number}`);
  for (const s of data.series) refOf(s.show);

  // 1. Séries. Celles désignées par id TheTVDB d'abord : elles servent à départager les titres ambigus qui suivent.
  // Séries « connues » : déjà dans l'historique ou les séries de l'utilisateur, ou retrouvées sûrement dans cet import.
  const known = new Set<number>([
    ...(db.prepare('SELECT DISTINCT e.show_id AS id FROM watched w JOIN episodes e ON e.id = w.episode_id WHERE w.user_id = ?').all(userId) as { id: number }[]).map((r) => r.id),
    ...(db.prepare('SELECT show_id AS id FROM user_shows WHERE user_id = ?').all(userId) as { id: number }[]).map((r) => r.id),
  ]);
  const resolved = new Map<string, Resolved>();
  let n = 0;
  const ordered = [...refs].sort(([, a], [, b]) => Number(b.ref.tvdbId !== null) - Number(a.ref.tvdbId !== null));
  for (const [k, { ref, positions }] of ordered) {
    try {
      const r = await resolveShow(deps, ref, positions, known);
      if (r && ref.tvdbId !== null) known.add(r.showId);
      if (!r) throw new Error('introuvable sur TMDB');
      resolved.set(k, r);
      report.shows.found++;
      if (r.approximate) report.shows.approximate.push({ title: label(ref), matched: r.approximate });
    } catch (err) {
      report.shows.missing.push(label(ref));
      log(`série « ${label(ref)} » non retrouvée : ${err instanceof Error ? err.message : String(err)}`);
    }
    if (++n % 20 === 0) log(`${n}/${refs.size} séries…`);
  }

  // 2. Épisodes, au plus ancien visionnage.
  const byPosition = db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season = ? AND number = ? AND removed_at IS NULL');
  const earliest = new Map<number, string>();
  const missingKeys = new Set<string>();
  const missing = (w: ImportWatch) => {
    const k = `${showKey(w.show)}:${w.season}:${w.number}`;
    if (missingKeys.has(k)) return;
    missingKeys.add(k);
    report.episodes.missing.push({ show: w.show.title, season: w.season, number: w.number });
  };
  for (const w of data.watches) {
    const show = resolved.get(showKey(w.show));
    if (!show) { missing(w); continue; }
    let row = byPosition.get(show.showId, w.season, w.number) as { id: number } | undefined;
    if (!row && w.tvdbEpisodeId !== null) {
      const ep = await catalog.findEpisodeByTvdb(w.tvdbEpisodeId).catch(() => null);
      if (ep && ep.showId === show.showId) row = byPosition.get(show.showId, ep.season, ep.number) as { id: number } | undefined;
    }
    if (!row) { missing(w); continue; }
    const prev = earliest.get(row.id);
    if (!prev || w.watchedAt < prev) earliest.set(row.id, w.watchedAt);
  }

  // 3. Suivi : de côté seulement si toutes les sources le disent ; date d'ajout la plus ancienne connue.
  const relations = new Map<number, { shelved: boolean; addedAt: string | null }>();
  for (const s of data.series) {
    const show = resolved.get(showKey(s.show));
    if (!show || (!s.followed && !s.shelved)) continue;
    const prev = relations.get(show.showId);
    const addedAt = [prev?.addedAt, s.addedAt].filter((x): x is string => !!x).sort()[0] ?? null;
    relations.set(show.showId, { shelved: (prev?.shelved ?? true) && s.shelved, addedAt });
  }
  const firstWatch = new Map<number, string>();
  for (const [episodeId, at] of earliest) {
    const showId = (db.prepare('SELECT show_id AS id FROM episodes WHERE id = ?').get(episodeId) as { id: number }).id;
    if (!firstWatch.has(showId) || at < (firstWatch.get(showId) as string)) firstWatch.set(showId, at);
  }

  // 4. Écriture, en une transaction.
  const seen = new Set((db.prepare('SELECT episode_id AS id FROM watched WHERE user_id = ?').all(userId) as { id: number }[]).map((r) => r.id));
  const tracked = new Set(getUserShowsFor(db, userId, [...relations.keys()]).map((r) => r.showId));
  const write = () => {
    for (const [episodeId, at] of earliest) {
      if (seen.has(episodeId)) { report.episodes.alreadySeen++; continue; }
      if (!opts.dryRun) putWatched(db, userId, episodeId, at, false);
      report.episodes.imported++;
    }
    for (const [showId, r] of relations) {
      if (tracked.has(showId)) { report.relations.kept++; continue; }
      if (!opts.dryRun) insertUserShow(db, userId, showId, r.shelved ? 'shelved' : 'followed', r.addedAt ?? firstWatch.get(showId) ?? new Date().toISOString());
      if (r.shelved) report.relations.shelved++; else report.relations.followed++;
    }
  };
  if (opts.dryRun) write(); else transaction(db, write);
  return report;
}

const label = (ref: ShowRef) => (ref.year ? `${ref.title} (${ref.year})` : ref.title);

async function resolveShow(deps: ImportDeps, ref: ShowRef, positions: Set<string>, known: ReadonlySet<number>): Promise<Resolved | null> {
  const { db, catalog } = deps;
  if (ref.tvdbId !== null) {
    const id = await catalog.findShowByTvdb(ref.tvdbId);
    if (id === null) return null;
    await catalog.ensureShow(id);
    return { showId: id, approximate: null };
  }

  // Titre : séries déjà en cache et recherche TMDB (interrogée même si le cache a ce titre : un homonyme peut y manquer).
  const want = normTitle(ref.title);
  const yearOf = new Map<number, number | null>();
  const local = (db.prepare('SELECT id, name, original_name AS originalName, first_air_date AS firstAirDate FROM shows').all() as
    { id: number; name: string; originalName: string; firstAirDate: string | null }[])
    .filter((s) => (normTitle(s.name) === want || normTitle(s.originalName) === want) && (!ref.year || s.firstAirDate?.startsWith(String(ref.year))));
  for (const s of local) yearOf.set(s.id, Number(s.firstAirDate?.slice(0, 4)) || null);
  const isExact = (r: SearchResult) => normTitle(r.name) === want || normTitle(r.originalName) === want;
  let results = await catalog.searchShows(ref.title, ref.year ?? undefined);
  if (ref.year && !results.some(isExact)) results = [...results, ...(await catalog.searchShows(ref.title))];
  for (const r of results) if (!yearOf.has(r.id)) yearOf.set(r.id, r.year);
  let candidates = [...new Set([...results.filter(isExact).map((r) => r.id), ...local.map((s) => s.id)])];
  // Aucun titre identique (titre traduit, sous-titre) : les premiers résultats, départagés par les épisodes vus.
  const approximate = !candidates.length;
  if (approximate) candidates = [...new Set(results.map((r) => r.id))].slice(0, CANDIDATES_MAX);
  if (!candidates.length) return null;

  // Plusieurs candidats, classés par épisodes vus qu'ils contiennent. Une série déjà connue l'emporte si elle en contient
  // au moins KNOWN_RATIO du meilleur (les numérotations diffèrent un peu : « Terra Nova » de 2011, pilote double compté 2 fois
  // chez BetaSeries, 10 positions sur 11, contre 11 pour l'homonyme de 2020). Ensuite : l'année la plus proche, l'ordre TMDB.
  let bestId = candidates.find((id) => known.has(id)) ?? (candidates[0] as number);
  if (candidates.length > 1 && positions.size) {
    const count = db.prepare('SELECT season, number FROM episodes WHERE show_id = ? AND removed_at IS NULL');
    const examined = [...new Set([...candidates.slice(0, CANDIDATES_MAX), ...candidates.filter((id) => known.has(id))])];
    const scored: { id: number; hits: number; known: boolean; gap: number }[] = [];
    for (const id of examined) {
      await catalog.ensureShow(id);
      const hits = (count.all(id) as { season: number; number: number }[]).filter((e) => positions.has(`${e.season}:${e.number}`)).length;
      const y = yearOf.get(id);
      scored.push({ id, hits, known: known.has(id), gap: ref.year && y ? Math.abs(y - ref.year) : Infinity });
    }
    const max = Math.max(...scored.map((c) => c.hits));
    const knownOk = scored.filter((c) => c.known && c.hits > 0 && c.hits >= KNOWN_RATIO * max);
    const pool = knownOk.length ? knownOk : scored.filter((c) => c.hits === max);
    pool.sort((x, y) => y.hits - x.hits || x.gap - y.gap);
    bestId = (pool[0] as { id: number }).id;
  }
  const best = { id: bestId };
  await catalog.ensureShow(best.id);
  const name = (db.prepare('SELECT name FROM shows WHERE id = ?').get(best.id) as { name: string } | undefined)?.name ?? '';
  return { showId: best.id, approximate: approximate ? name : null };
}
