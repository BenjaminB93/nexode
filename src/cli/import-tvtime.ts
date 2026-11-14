// Importe un export TV Time (tracking-prod-records-v2.csv) dans le compte <nom>.
// Usage : node --env-file-if-exists=.env src/cli/import-tvtime.ts <fichier.csv> <nom> [--essai]
// --essai : affiche le bilan sans rien écrire dans le compte.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { usernameKey } from '../domain/accounts.ts';
import { parseTvTime } from '../domain/tvtime.ts';
import { createCatalog } from '../infra/catalog.ts';
import { getAccountByKey } from '../infra/repos.ts';
import { createTmdb } from '../infra/tmdb.ts';
import { importTvTime } from '../usecases/import-tvtime.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--essai');
const [file, username] = args.filter((a) => a !== '--essai');
if (!file || !username) {
  console.error('Usage : node --env-file-if-exists=.env src/cli/import-tvtime.ts <fichier.csv> <nom> [--essai]');
  process.exit(2);
}
const config = loadConfig();
if (!config.tmdbToken) {
  console.error('TMDB_READ_TOKEN absent : renseigner le jeton TMDB dans .env.');
  process.exit(1);
}
const db = openDb(config.dbPath);
migrate(db);
const user = getAccountByKey(db, usernameKey(username));
if (!user) {
  console.error(`Compte « ${username} » introuvable.`);
  process.exit(1);
}

const data = parseTvTime(readFileSync(file, 'utf8'));
console.log(`${data.watches.length} épisodes vus, ${data.series.length} séries dans l'export${dryRun ? ' (essai : rien ne sera écrit)' : ''}`);
const tmdb = createTmdb({ token: config.tmdbToken });
const report = await importTvTime({ db, tmdb, catalog: createCatalog({ db, tmdb }), log: (m) => console.log(m) }, user.id, data, { dryRun });
db.close();

const { shows, episodes, relations } = report;
console.log(`séries : ${shows.found} retrouvées, ${shows.missing.length} non retrouvées`);
for (const s of shows.missing) console.log(`  - ${s.name} (TheTVDB ${s.tvdbId})`);
console.log(`épisodes : ${episodes.imported} importés, ${episodes.alreadySeen} déjà vus, ${episodes.missing.length} non retrouvés`);
const bySeries = new Map<string, string[]>();
for (const e of episodes.missing) bySeries.set(e.show, [...(bySeries.get(e.show) ?? []), `S${e.season}E${e.number}`]);
for (const [show, eps] of bySeries) console.log(`  - ${show} : ${eps.length > 8 ? `${eps.slice(0, 8).join(', ')}… (${eps.length})` : eps.join(', ')}`);
console.log(`suivi : ${relations.followed} suivies, ${relations.shelved} de côté, ${relations.kept} déjà dans tes séries (inchangées)`);
console.log(`appels HTTP TMDB : ${tmdb.calls()}`);
