import { type Db, transaction } from '../db/index.ts';
import { type ImportData, type ImportWatch, type ShowRef, normTitle, showKey } from '../domain/imports.ts';
import { getUserShowsFor, insertUserShow, putWatched } from '../infra/repos.ts';
import type { Catalog, SearchResult } from '../ports.ts';

// Import d'un historique venu d'une autre appli (TV Time, BetaSeries), en deux temps :
// 1. matchShows : chaque série de l'export reçoit une série TMDB proposée. Sûre (id TheTVDB, ou titre identique à une seule
//    série qui contient presque tous les épisodes vus) ou à confirmer (homonymes, titre seulement rapproché), avec candidats.
// 2. applyImport : avec les choix (proposés, confirmés ou corrigés par l'utilisateur), écrit l'historique et le suivi.
// Épisodes : position (saison, numéro), repli sur l'id TheTVDB de l'épisode. Plusieurs sources pour un même épisode :
// le plus ancien visionnage. Idempotent : un épisode déjà vu garde sa date, une série déjà dans « mes séries » son état.

export type ImportDeps = { db: Db; catalog: Catalog; log?: (message: string) => void };

export type Candidate = { id: number; name: string; year: number | null; seasonCount: number; posterPath: string | null; hits: number };

// sure : importée sans question ; ambiguous : plusieurs séries de ce titre ; approximate : aucun titre identique ;
// missing : rien trouvé (l'utilisateur peut chercher). choice : série proposée (null = ne pas importer).
export type Match = {
  key: string; title: string; year: number | null; episodes: number;
  kind: 'sure' | 'ambiguous' | 'approximate' | 'missing';
  choice: number | null; candidates: Candidate[];
};

export type ImportReport = {
  shows: { imported: number; skipped: string[] };
  episodes: { imported: number; alreadySeen: number; missing: { show: string; season: number; number: number }[] };
  relations: { followed: number; shelved: number; kept: number };
};

const CANDIDATES_MAX = 3;
const KNOWN_RATIO = 0.8;     // une série déjà connue l'emporte si elle contient au moins 80 % des épisodes du meilleur candidat
const SURE_RATIO = 0.9;      // proposition sûre : contient au moins 90 % des épisodes vus…
const RIVAL_RATIO = 0.5;     // … et aucun homonyme n'en contient plus de la moitié autant

type Ref = { ref: ShowRef; positions: Set<string> };

function refsOf(data: ImportData): Map<string, Ref> {
  const refs = new Map<string, Ref>();
  const refOf = (ref: ShowRef) => {
    const k = showKey(ref);
    let e = refs.get(k);
    if (!e) refs.set(k, (e = { ref, positions: new Set() }));
    return e;
  };
  for (const w of data.watches) refOf(w.show).positions.add(`${w.season}:${w.number}`);
  for (const s of data.series) refOf(s.show);
  return refs;
}

export async function matchShows(deps: ImportDeps, userId: number, data: ImportData): Promise<Match[]> {
  const { db } = deps;
  const log = deps.log ?? (() => {});
  // Séries « connues » : déjà dans l'historique ou les séries de l'utilisateur, ou retrouvées par id TheTVDB dans cet import.
  const known = new Set<number>([
    ...(db.prepare('SELECT DISTINCT e.show_id AS id FROM watched w JOIN episodes e ON e.id = w.episode_id WHERE w.user_id = ?').all(userId) as { id: number }[]).map((r) => r.id),
    ...(db.prepare('SELECT show_id AS id FROM user_shows WHERE user_id = ?').all(userId) as { id: number }[]).map((r) => r.id),
  ]);
  const refs = refsOf(data);
  // Ids TheTVDB d'abord : ils servent à départager les titres ambigus qui suivent.
  const ordered = [...refs].sort(([, a], [, b]) => Number(b.ref.tvdbId !== null) - Number(a.ref.tvdbId !== null));
  const matches: Match[] = [];
  let n = 0;
  for (const [key, { ref, positions }] of ordered) {
    let m: Match;
    try {
      m = await matchOne(deps, key, ref, positions, known);
    } catch (err) {
      log(`série « ${label(ref)} » : ${err instanceof Error ? err.message : String(err)}`);
      m = { key, title: ref.title, year: ref.year, episodes: positions.size, kind: 'missing', choice: null, candidates: [] };
    }
    if (m.kind === 'sure' && m.choice !== null && ref.tvdbId !== null) known.add(m.choice);
    matches.push(m);
    if (++n % 20 === 0) log(`${n}/${refs.size} séries…`);
  }
  return matches;
}

async function matchOne(deps: ImportDeps, key: string, ref: ShowRef, positions: Set<string>, known: ReadonlySet<number>): Promise<Match> {
  const { db, catalog } = deps;
  const base = { key, title: ref.title, year: ref.year, episodes: positions.size };
  const count = db.prepare('SELECT season, number FROM episodes WHERE show_id = ? AND removed_at IS NULL');
  const candidate = async (id: number): Promise<Candidate> => {
    await catalog.ensureShow(id);
    const s = db.prepare(`SELECT name, first_air_date AS d, poster_path AS p, (SELECT count(*) FROM seasons WHERE show_id = shows.id) AS n
      FROM shows WHERE id = ?`).get(id) as { name: string; d: string | null; p: string | null; n: number };
    const hits = (count.all(id) as { season: number; number: number }[]).filter((e) => positions.has(`${e.season}:${e.number}`)).length;
    return { id, name: s.name, year: Number(s.d?.slice(0, 4)) || null, seasonCount: s.n, posterPath: s.p, hits };
  };

  if (ref.tvdbId !== null) {
    const id = await catalog.findShowByTvdb(ref.tvdbId);
    if (id !== null) return { ...base, kind: 'sure', choice: id, candidates: [await candidate(id)] };
  }

  // Titre : séries déjà en cache et recherche TMDB (interrogée même si le cache a ce titre : un homonyme peut y manquer).
  const want = normTitle(ref.title);
  const local = (db.prepare('SELECT id, name, original_name AS originalName, first_air_date AS firstAirDate FROM shows').all() as
    { id: number; name: string; originalName: string; firstAirDate: string | null }[])
    .filter((s) => (normTitle(s.name) === want || normTitle(s.originalName) === want) && (!ref.year || s.firstAirDate?.startsWith(String(ref.year))))
    .map((s) => s.id);
  const isExact = (r: SearchResult) => normTitle(r.name) === want || normTitle(r.originalName) === want;
  let results = await catalog.searchShows(ref.title, ref.year ?? undefined);
  if (ref.year && !results.some(isExact)) results = [...results, ...(await catalog.searchShows(ref.title))];
  const exact = [...new Set([...results.filter(isExact).map((r) => r.id), ...local])];
  const others = results.map((r) => r.id).filter((id) => !exact.includes(id));
  const ids = [...new Set([...exact, ...others.slice(0, Math.max(0, CANDIDATES_MAX - exact.length)), ...exact.filter((id) => known.has(id))])];
  if (!ids.length) return { ...base, kind: 'missing', choice: null, candidates: [] };

  const cands: Candidate[] = [];
  for (const id of ids) cands.push(await candidate(id));
  const yearGap = (c: Candidate) => (ref.year && c.year ? Math.abs(c.year - ref.year) : Infinity);
  const order = (list: Candidate[]) => [...list].sort((a, b) => b.hits - a.hits || yearGap(a) - yearGap(b));
  // Proposition : le plus d'épisodes vus ; une série déjà connue l'emporte si elle en contient au moins KNOWN_RATIO du meilleur
  // (« Terra Nova » de 2011 vue via TV Time, pilote double compté 2 fois chez BetaSeries : 10 positions sur 11, contre 11 pour 2020).
  const pool = exact.length ? cands.filter((c) => exact.includes(c.id)) : cands;
  const max = Math.max(...pool.map((c) => c.hits));
  const knownOk = pool.filter((c) => known.has(c.id) && c.hits > 0 && c.hits >= KNOWN_RATIO * max);
  const best = order(knownOk.length ? knownOk : pool)[0] as Candidate;
  const candidates = [best, ...order(cands.filter((c) => c !== best))];

  // Sûre : titre identique et la proposition contient presque tous les épisodes vus, sans homonyme sérieux
  // (le suivant en contient moins de la moitié). Sans épisode vu : titre identique unique, ou série déjà connue.
  const runnerUp = order(pool.filter((c) => c !== best))[0];
  const sure = exact.length > 0 && (positions.size
    ? best.hits >= SURE_RATIO * positions.size && (!runnerUp || runnerUp.hits <= RIVAL_RATIO * best.hits)
    : exact.length === 1 || known.has(best.id));
  const kind = sure ? 'sure' : exact.length ? 'ambiguous' : 'approximate';
  return { ...base, kind, choice: best.id, candidates: sure ? [best] : candidates };
}

// choices : clé de série → id TMDB, ou null pour ne pas l'importer. Une série absente des choix n'est pas importée.
export async function applyImport(deps: ImportDeps, userId: number, data: ImportData, choices: ReadonlyMap<string, number | null>, opts: { dryRun?: boolean } = {}): Promise<ImportReport> {
  const { db, catalog } = deps;
  const report: ImportReport = {
    shows: { imported: 0, skipped: [] },
    episodes: { imported: 0, alreadySeen: 0, missing: [] },
    relations: { followed: 0, shelved: 0, kept: 0 },
  };
  const chosen = new Map<string, number>();
  for (const [key, { ref }] of refsOf(data)) {
    const id = choices.get(key) ?? null;
    if (id === null) { report.shows.skipped.push(label(ref)); continue; }
    try {
      await catalog.ensureShow(id);
      chosen.set(key, id);
      report.shows.imported++;
    } catch {
      report.shows.skipped.push(label(ref));
    }
  }

  // Épisodes, au plus ancien visionnage. Ceux des séries non importées ne sont pas comptés comme manquants.
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
    const showId = chosen.get(showKey(w.show));
    if (showId === undefined) continue;
    let row = byPosition.get(showId, w.season, w.number) as { id: number } | undefined;
    if (!row && w.tvdbEpisodeId !== null) {
      const ep = await catalog.findEpisodeByTvdb(w.tvdbEpisodeId).catch(() => null);
      if (ep && ep.showId === showId) row = byPosition.get(showId, ep.season, ep.number) as { id: number } | undefined;
    }
    if (!row) { missing(w); continue; }
    const prev = earliest.get(row.id);
    if (!prev || w.watchedAt < prev) earliest.set(row.id, w.watchedAt);
  }

  // Suivi : de côté seulement si toutes les sources le disent ; date d'ajout la plus ancienne connue.
  const relations = new Map<number, { shelved: boolean; addedAt: string | null }>();
  for (const s of data.series) {
    const showId = chosen.get(showKey(s.show));
    if (showId === undefined || (!s.followed && !s.shelved)) continue;
    const prev = relations.get(showId);
    const addedAt = [prev?.addedAt, s.addedAt].filter((x): x is string => !!x).sort()[0] ?? null;
    relations.set(showId, { shelved: (prev?.shelved ?? true) && s.shelved, addedAt });
  }
  const showOf = db.prepare('SELECT show_id AS id FROM episodes WHERE id = ?');
  const firstWatch = new Map<number, string>();
  for (const [episodeId, at] of earliest) {
    const showId = (showOf.get(episodeId) as { id: number }).id;
    if (!firstWatch.has(showId) || at < (firstWatch.get(showId) as string)) firstWatch.set(showId, at);
  }

  // Écriture, en une transaction.
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

// Import sans intervention (ligne de commande, tests) : les séries proposées sont acceptées telles quelles.
export async function importHistory(deps: ImportDeps, userId: number, data: ImportData, opts: { dryRun?: boolean } = {}): Promise<{ matches: Match[]; report: ImportReport }> {
  const matches = await matchShows(deps, userId, data);
  const report = await applyImport(deps, userId, data, new Map(matches.map((m) => [m.key, m.choice])), opts);
  return { matches, report };
}

const label = (ref: ShowRef) => (ref.year ? `${ref.title} (${ref.year})` : ref.title);
