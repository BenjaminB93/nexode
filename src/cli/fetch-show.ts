// Charge une série TMDB dans le cache local et affiche ce qui est en base.
// Usage : node --env-file-if-exists=.env src/cli/fetch-show.ts <idTMDB> [pays=FR]
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { createCatalog } from '../infra/catalog.ts';
import { createTmdb, TmdbError } from '../infra/tmdb.ts';

const [idArg, countryArg = 'FR'] = process.argv.slice(2);
const showId = Number(idArg);
if (!Number.isInteger(showId) || showId <= 0 || !/^[A-Za-z]{2}$/.test(countryArg)) {
  console.error('Usage : node --env-file-if-exists=.env src/cli/fetch-show.ts <idTMDB> [pays=FR]');
  process.exit(2);
}
const country = countryArg.toUpperCase();

const config = loadConfig();
if (!config.tmdbToken) {
  console.error('TMDB_READ_TOKEN absent : renseigner le jeton TMDB dans .env (voir .env.example).');
  process.exit(1);
}

const db = openDb(config.dbPath);
migrate(db);
const tmdb = createTmdb({ token: config.tmdbToken });
const catalog = createCatalog({ db, tmdb });

try {
  await catalog.ensureShow(showId);
  await catalog.ensureProviders(showId, country);
} catch (err) {
  console.error(err instanceof TmdbError ? err.message : err);
  db.close();
  process.exit(1);
}

const show = db.prepare('SELECT name, original_name, status, first_air_date, tvdb_id, refreshed_at FROM shows WHERE id = ?').get(showId) as {
  name: string;
  original_name: string;
  status: string;
  first_air_date: string | null;
  tvdb_id: number | null;
  refreshed_at: string;
};
const seasons = db
  .prepare(`
    SELECT s.number, count(e.id) AS episodes, sum(e.title_is_vo) AS vo, sum(e.title IS NULL) AS untitled
    FROM seasons s LEFT JOIN episodes e ON e.show_id = s.show_id AND e.season = s.number
    WHERE s.show_id = ? GROUP BY s.number ORDER BY s.number
  `)
  .all(showId) as { number: number; episodes: number; vo: number | null; untitled: number | null }[];
const providers = db.prepare('SELECT name FROM providers WHERE show_id = ? AND season = ? AND country = ? ORDER BY priority');

const total = (k: 'episodes' | 'vo' | 'untitled') => seasons.reduce((n, s) => n + (s[k] ?? 0), 0);
console.log(`${show.name}${show.original_name !== show.name ? ` (${show.original_name})` : ''} — TMDB ${showId}, TVDB ${show.tvdb_id ?? '?'}`);
console.log(`statut ${show.status}, début ${show.first_air_date ?? '?'}, relevé ${show.refreshed_at}`);
console.log(`${seasons.length} saisons, ${total('episodes')} épisodes, ${total('vo')} titres VO, ${total('untitled')} sans titre`);
for (const s of seasons) {
  const names = (providers.all(showId, s.number, country) as { name: string }[]).map((p) => p.name);
  console.log(`  S${s.number} : ${s.episodes} ép.${s.vo ? `, ${s.vo} VO` : ''} — ${country} : ${names.join(', ') || 'aucune plateforme'}`);
}
console.log(`appels HTTP TMDB : ${tmdb.calls()}`);
db.close();
