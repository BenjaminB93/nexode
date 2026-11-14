// Catalogue : cache local des séries TMDB (séries, saisons ≥ 1, épisodes, plateformes).
import { type Db, transaction } from '../db/index.ts';
import type { Catalog, SearchResult } from '../ports.ts';
import { type Tmdb, isNotFound } from './tmdb.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const APPEND_MAX = 20; // limite TMDB d'append_to_response
const SEARCH_MAX = 20;
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

// En fr-FR, TMDB renvoie « Épisode N » quand l'épisode n'a pas de titre traduit.
const GENERIC_TITLE = /^(Épisode|Episode) \d+$/i;
// Variantes de plateformes écartées (chaînes revendues par Amazon / Apple, offres avec publicité).
const EXCLUDED_PROVIDER = /amazon channel|apple tv channel|with ads/i;

const STATUS: Record<string, string> = {
  'Returning Series': 'returning',
  Ended: 'ended',
  Canceled: 'canceled',
  'In Production': 'in_production',
  Planned: 'planned',
  Pilot: 'pilot',
};

type TmdbEpisode = {
  id: number;
  episode_number: number;
  name?: string | null;
  overview?: string | null;
  air_date?: string | null;
  runtime?: number | null;
  still_path?: string | null;
};

type TmdbSeason = {
  season_number: number;
  name?: string | null;
  overview?: string | null;
  air_date?: string | null;
  poster_path?: string | null;
  episodes?: TmdbEpisode[];
};

type TmdbShow = {
  id: number;
  name: string;
  original_name: string;
  original_language: string;
  overview?: string | null;
  first_air_date?: string | null;
  status?: string | null;
  poster_path?: string | null;
  external_ids?: { tvdb_id?: number | null };
  seasons?: { season_number: number }[];
};

type TmdbProvider = { provider_id: number; provider_name: string; logo_path?: string | null; display_priority?: number };
type TmdbProviders = { results?: Record<string, { flatrate?: TmdbProvider[] } | undefined> };
type TmdbSearch = { results?: { id: number; name: string; original_name?: string; first_air_date?: string | null; poster_path?: string | null }[] };
type TmdbFind = {
  tv_results?: { id: number }[];
  tv_episode_results?: { show_id: number; season_number: number; episode_number: number }[];
};

type EpisodeRow = {
  id: number;
  season: number;
  number: number;
  title: string | null;
  title_is_vo: number;
  overview: string;
  air_date: string | null;
  runtime: number | null;
  still_path: string | null;
};

type SeasonRow = { number: number; name: string; overview: string; air_date: string | null; poster_path: string | null };

export type CatalogDeps = { db: Db; tmdb: Tmdb; now?: () => Date; warn?: (message: string) => void };

const text = (s: string | null | undefined): string => (s ?? '').trim();
const orNull = (s: string | null | undefined): string | null => text(s) || null;
const isGeneric = (title: string | null | undefined): boolean => !text(title) || GENERIC_TITLE.test(text(title));

export function mapStatus(status: string | null | undefined): string {
  return STATUS[status ?? ''] ?? 'unknown';
}

// Garde l'abonnement (flatrate) d'un pays, sans les variantes exclues, une ligne par plateforme.
export function pickProviders(res: TmdbProviders, country: string): { provider_id: number; name: string; logo_path: string | null; priority: number }[] {
  const out = new Map<number, { provider_id: number; name: string; logo_path: string | null; priority: number }>();
  for (const p of res.results?.[country]?.flatrate ?? []) {
    if (EXCLUDED_PROVIDER.test(p.provider_name)) continue;
    const priority = p.display_priority ?? 999;
    const prev = out.get(p.provider_id);
    if (!prev || priority < prev.priority) out.set(p.provider_id, { provider_id: p.provider_id, name: p.provider_name, logo_path: p.logo_path ?? null, priority });
  }
  return [...out.values()].sort((a, b) => a.priority - b.priority);
}

export function createCatalog({ db, tmdb, now = () => new Date(), warn = console.warn }: CatalogDeps): Catalog {
  const inflight = new Map<number, Promise<void>>();
  const isFresh = (iso: string | undefined) => iso !== undefined && now().getTime() - Date.parse(iso) < DAY_MS;

  // Série + saisons demandées, regroupées par appels de 20 saisons au plus.
  async function fetchSeasons(showId: number, numbers: number[], language: string): Promise<{ show: TmdbShow | null; seasons: Map<number, TmdbSeason> }> {
    const seasons = new Map<number, TmdbSeason>();
    let show: TmdbShow | null = null;
    for (let i = 0; i < numbers.length; i += APPEND_MAX) {
      const chunk = numbers.slice(i, i + APPEND_MAX);
      const res = await tmdb.get<TmdbShow & Record<string, unknown>>(`/tv/${showId}`, {
        language,
        append_to_response: chunk.map((n) => `season/${n}`).join(','),
      });
      show ??= res;
      for (const n of chunk) {
        const season = res[`season/${n}`] as TmdbSeason | undefined;
        if (!season) throw new Error(`TMDB : saison ${n} absente de la réponse pour la série ${showId}`);
        seasons.set(n, season);
      }
    }
    return { show, seasons };
  }

  async function doRefresh(showId: number): Promise<void> {
    const show = await tmdb.get<TmdbShow>(`/tv/${showId}`, { language: 'fr-FR', append_to_response: 'external_ids' });
    const numbers = [...new Set((show.seasons ?? []).map((s) => s.season_number).filter((n) => n >= 1))].sort((a, b) => a - b);
    const fr = await fetchSeasons(showId, numbers, 'fr-FR');

    // Repli sur la langue originale, seulement pour les saisons qui ont des titres génériques.
    const lang = text(show.original_language);
    const needVo = numbers.filter((n) => fr.seasons.get(n)?.episodes?.some((e) => isGeneric(e.name)));
    const vo = lang && lang !== 'fr' && needVo.length ? await fetchSeasons(showId, needVo, lang) : null;

    const seasons: SeasonRow[] = [];
    const episodes: EpisodeRow[] = [];
    for (const n of numbers) {
      const s = fr.seasons.get(n)!;
      const sVo = vo?.seasons.get(n);
      const voById = new Map((sVo?.episodes ?? []).map((e) => [e.id, e]));
      seasons.push({
        number: n,
        name: text(s.name) || text(sVo?.name) || `Saison ${n}`,
        overview: text(s.overview) || text(sVo?.overview),
        air_date: orNull(s.air_date),
        poster_path: orNull(s.poster_path),
      });
      for (const e of s.episodes ?? []) {
        const eVo = voById.get(e.id);
        let title: string | null = text(e.name);
        let titleIsVo = 0;
        if (isGeneric(title)) {
          // Langue originale française : le titre FR est l'original, rien à recharger.
          const original = lang === 'fr' ? null : eVo?.name;
          title = isGeneric(original) ? null : text(original);
          titleIsVo = title === null ? 0 : 1;
        }
        episodes.push({
          id: e.id,
          season: n,
          number: e.episode_number,
          title,
          title_is_vo: titleIsVo,
          overview: text(e.overview) || text(eVo?.overview),
          air_date: orNull(e.air_date),
          runtime: e.runtime ?? null,
          still_path: orNull(e.still_path),
        });
      }
    }

    transaction(db, () => {
      db.prepare(`
        INSERT INTO shows (id, name, original_name, original_language, overview, first_air_date, status, poster_path, tvdb_id, refreshed_at)
        VALUES (:id, :name, :original_name, :original_language, :overview, :first_air_date, :status, :poster_path, :tvdb_id, :refreshed_at)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name, original_name = excluded.original_name, original_language = excluded.original_language,
          overview = excluded.overview, first_air_date = excluded.first_air_date, status = excluded.status,
          poster_path = excluded.poster_path, tvdb_id = excluded.tvdb_id, refreshed_at = excluded.refreshed_at
      `).run({
        id: showId,
        name: text(show.name) || text(show.original_name),
        original_name: text(show.original_name) || text(show.name),
        original_language: lang,
        overview: text(show.overview) || text(vo?.show?.overview),
        first_air_date: orNull(show.first_air_date),
        status: mapStatus(show.status),
        poster_path: orNull(show.poster_path),
        tvdb_id: show.external_ids?.tvdb_id ?? null,
        refreshed_at: now().toISOString(),
      });

      const upsertSeason = db.prepare(`
        INSERT INTO seasons (show_id, number, name, overview, air_date, poster_path)
        VALUES (:show_id, :number, :name, :overview, :air_date, :poster_path)
        ON CONFLICT (show_id, number) DO UPDATE SET
          name = excluded.name, overview = excluded.overview, air_date = excluded.air_date, poster_path = excluded.poster_path
      `);
      for (const s of seasons) upsertSeason.run({ show_id: showId, ...s });

      // Épisodes actuels mis à l'écart (removed_at) le temps des upserts : une renumérotation TMDB ne heurte pas l'index de position.
      // Ceux que TMDB renvoie redeviennent actuels ; les autres restent retirés (si vus) ou sont supprimés.
      const existing = db.prepare('SELECT id, season, number FROM episodes WHERE show_id = ? AND removed_at IS NULL').all(showId) as { id: number; season: number; number: number }[];
      db.prepare('UPDATE episodes SET removed_at = ? WHERE show_id = ? AND removed_at IS NULL').run(now().toISOString(), showId);

      const upsertEpisode = db.prepare(`
        INSERT INTO episodes (id, show_id, season, number, title, title_is_vo, overview, air_date, runtime, still_path)
        VALUES (:id, :show_id, :season, :number, :title, :title_is_vo, :overview, :air_date, :runtime, :still_path)
        ON CONFLICT (id) DO UPDATE SET
          show_id = excluded.show_id, season = excluded.season, number = excluded.number, title = excluded.title,
          title_is_vo = excluded.title_is_vo, overview = excluded.overview, air_date = excluded.air_date,
          runtime = excluded.runtime, still_path = excluded.still_path, removed_at = NULL
      `);
      for (const e of episodes) upsertEpisode.run({ show_id: showId, ...e });

      // Épisodes disparus chez TMDB. Un épisode vu reste en base, retiré (removed_at), avec son numéro d'origine.
      const incomingIds = new Set(episodes.map((e) => e.id));
      const existingIds = new Set(existing.map((e) => e.id));
      const byPosition = new Map(episodes.map((e) => [`${e.season}:${e.number}`, e.id]));
      const moveWatched = db.prepare('UPDATE OR IGNORE watched SET episode_id = :to WHERE episode_id = :from');
      const dropWatched = db.prepare('DELETE FROM watched WHERE episode_id = ?');
      const dropEpisode = db.prepare('DELETE FROM episodes WHERE id = ?');
      for (const old of existing) {
        if (incomingIds.has(old.id)) continue;
        // Id inconnu à la même position = même épisode, nouvel id TMDB : l'historique suit.
        // Id déjà en base = renumérotation : l'épisode à cette place est un autre épisode.
        const replacement = byPosition.get(`${old.season}:${old.number}`);
        if (replacement !== undefined && !existingIds.has(replacement)) {
          moveWatched.run({ from: old.id, to: replacement });
          dropWatched.run(old.id);
          dropEpisode.run(old.id);
        }
      }
      // Épisodes retirés que plus personne n'a vus (disparus à l'instant, ou remis en non vu depuis) : supprimés.
      db.prepare('DELETE FROM episodes WHERE show_id = ? AND removed_at IS NOT NULL AND id NOT IN (SELECT episode_id FROM watched)').run(showId);

      // Saisons disparues : supprimées seulement si vides.
      const kept = new Set(numbers);
      const oldSeasons = db.prepare('SELECT number FROM seasons WHERE show_id = ?').all(showId) as { number: number }[];
      const hasEpisodes = db.prepare('SELECT 1 FROM episodes WHERE show_id = ? AND season = ? LIMIT 1');
      const dropSeason = db.prepare('DELETE FROM seasons WHERE show_id = ? AND number = ?');
      for (const { number } of oldSeasons) {
        if (!kept.has(number) && !hasEpisodes.get(showId, number)) dropSeason.run(showId, number);
      }
    });
  }

  function refreshShow(showId: number): Promise<void> {
    let p = inflight.get(showId);
    if (!p) {
      p = doRefresh(showId).finally(() => inflight.delete(showId));
      inflight.set(showId, p);
    }
    return p;
  }

  // Échecs récents (clé → instant) : pas de nouvel appel TMDB avant FAILURE_COOLDOWN_MS.
  const failures = new Map<string, number>();
  const coolingDown = (key: string) => now().getTime() - (failures.get(key) ?? -Infinity) < FAILURE_COOLDOWN_MS;
  const failed = (key: string, what: string, err: unknown) => {
    failures.set(key, now().getTime());
    warn(`Catalogue : ${what} impossible, données en cache conservées (${err instanceof Error ? err.message : String(err)})`);
  };

  // Série déjà en cache : un échec de TMDB est journalisé et le cache périmé sert. Série absente : l'erreur remonte.
  async function ensureShow(showId: number): Promise<void> {
    const row = db.prepare('SELECT refreshed_at FROM shows WHERE id = ?').get(showId) as { refreshed_at: string } | undefined;
    if (!row) return refreshShow(showId);
    const key = `show:${showId}`;
    if (isFresh(row.refreshed_at) || coolingDown(key)) return;
    try {
      await refreshShow(showId);
      failures.delete(key);
    } catch (err) {
      failed(key, `rafraîchissement de la série ${showId}`, err);
    }
  }

  // Plateformes : un échec laisse la saison telle qu'en base (liste périmée, ou aucun relevé).
  async function ensureProviders(showId: number, country: string): Promise<void> {
    await ensureShow(showId);
    const cc = country.toUpperCase();
    const seasons = db.prepare('SELECT number FROM seasons WHERE show_id = ? ORDER BY number').all(showId) as { number: number }[];
    const fetchedAt = db.prepare('SELECT fetched_at FROM provider_fetches WHERE show_id = ? AND season = ? AND country = ?');

    const fetched: { season: number; list: ReturnType<typeof pickProviders> }[] = [];
    for (const { number } of seasons) {
      const row = fetchedAt.get(showId, number, cc) as { fetched_at: string } | undefined;
      const key = `providers:${showId}:${number}:${cc}`;
      if (isFresh(row?.fetched_at) || coolingDown(key)) continue;
      let res: TmdbProviders;
      try {
        res = await tmdb.get<TmdbProviders>(`/tv/${showId}/season/${number}/watch/providers`);
      } catch (err) {
        if (!isNotFound(err)) {
          failed(key, `relevé des plateformes (série ${showId}, saison ${number}, ${cc})`, err);
          continue;
        }
        res = {};
      }
      failures.delete(key);
      fetched.push({ season: number, list: pickProviders(res, cc) });
    }
    if (!fetched.length) return;

    const at = now().toISOString();
    transaction(db, () => {
      const clear = db.prepare('DELETE FROM providers WHERE show_id = ? AND season = ? AND country = ?');
      const mark = db.prepare(`
        INSERT INTO provider_fetches (show_id, season, country, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (show_id, season, country) DO UPDATE SET fetched_at = excluded.fetched_at
      `);
      const insert = db.prepare(`
        INSERT INTO providers (show_id, season, country, provider_id, name, logo_path, priority)
        VALUES (:show_id, :season, :country, :provider_id, :name, :logo_path, :priority)
      `);
      for (const { season, list } of fetched) {
        clear.run(showId, season, cc);
        mark.run(showId, season, cc, at);
        for (const p of list) insert.run({ show_id: showId, season, country: cc, ...p });
      }
    });
  }

  async function searchShows(query: string, year?: number): Promise<SearchResult[]> {
    const q = query.replace(/\s+/g, ' ').trim();
    if (!q) return [];
    const res = await tmdb.get<TmdbSearch>('/search/tv', { query: q, language: 'fr-FR', include_adult: 'false', first_air_date_year: year });
    return (res.results ?? []).slice(0, SEARCH_MAX).map((r) => {
      const y = Number(text(r.first_air_date).slice(0, 4));
      return { id: r.id, name: r.name, originalName: text(r.original_name) || r.name, year: Number.isInteger(y) && y > 0 ? y : null, posterPath: orNull(r.poster_path) };
    });
  }

  async function findShowByTvdb(tvdbId: number): Promise<number | null> {
    const cached = db.prepare('SELECT id FROM shows WHERE tvdb_id = ?').get(tvdbId) as { id: number } | undefined;
    if (cached) return cached.id;
    const res = await tmdb.get<TmdbFind>(`/find/${tvdbId}`, { external_source: 'tvdb_id' });
    return res.tv_results?.[0]?.id ?? null;
  }

  async function findEpisodeByTvdb(tvdbEpisodeId: number): Promise<{ showId: number; season: number; number: number } | null> {
    const ep = (await tmdb.get<TmdbFind>(`/find/${tvdbEpisodeId}`, { external_source: 'tvdb_id' })).tv_episode_results?.[0];
    return ep ? { showId: ep.show_id, season: ep.season_number, number: ep.episode_number } : null;
  }

  return { ensureShow, refreshShow, ensureProviders, searchShows, findShowByTvdb, findEpisodeByTvdb };
}
