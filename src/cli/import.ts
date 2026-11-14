// Importe des exports TV Time (tracking-prod-records-v2.csv) et/ou BetaSeries (episodes-*.csv, series-*.csv) dans le compte <nom>.
// Usage : node --env-file-if-exists=.env src/cli/import.ts <nom> <fichier.csv>... [--essai]
// --essai : affiche le bilan sans rien écrire dans le compte.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { usernameKey } from '../domain/accounts.ts';
import { parseImportFiles } from '../domain/import-files.ts';
import { FORMAT_LABELS } from '../domain/imports.ts';
import { createCatalog } from '../infra/catalog.ts';
import { getAccountByKey } from '../infra/repos.ts';
import { createTmdb } from '../infra/tmdb.ts';
import { importHistory } from '../usecases/import.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--essai');
const [username, ...paths] = args.filter((a) => a !== '--essai');
if (!username || !paths.length) {
  console.error('Usage : node --env-file-if-exists=.env src/cli/import.ts <nom> <fichier.csv>... [--essai]');
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

const { data, files } = parseImportFiles(paths.map((p) => ({ name: basename(p), text: readFileSync(p, 'utf8') })));
for (const f of files) console.log(`${f.name} : ${f.error ? `refusé (${f.error})` : FORMAT_LABELS[f.format!]}`);
if (files.some((f) => f.error)) process.exit(1);
console.log(`${data.watches.length} visionnages, ${data.series.length} séries${dryRun ? ' (essai : rien ne sera écrit)' : ''}`);

const tmdb = createTmdb({ token: config.tmdbToken });
const { matches, report } = await importHistory({ db, catalog: createCatalog({ db, tmdb }), log: (m) => console.log(m) }, user.id, data, { dryRun });
db.close();

// En ligne de commande, les séries proposées sont acceptées : on liste celles qu'une personne aurait dû confirmer.
const KIND = { ambiguous: 'homonymes', approximate: 'titre rapproché', missing: 'introuvable' } as const;
const toCheck = matches.filter((m) => m.kind !== 'sure');
console.log(`séries : ${matches.length - toCheck.length} sûres, ${toCheck.length} à vérifier`);
for (const m of toCheck) {
  const pick = m.candidates.find((c) => c.id === m.choice);
  console.log(`  - ${m.title}${m.year ? ` (${m.year})` : ''} [${KIND[m.kind as keyof typeof KIND]}] → ${pick ? `${pick.name} (${pick.year ?? '?'}, ${pick.hits}/${m.episodes} épisodes)` : 'non importée'}`);
}
const { episodes, relations } = report;
console.log(`épisodes : ${episodes.imported} importés, ${episodes.alreadySeen} déjà vus, ${episodes.missing.length} non retrouvés`);
const bySeries = new Map<string, string[]>();
for (const e of episodes.missing) bySeries.set(e.show, [...(bySeries.get(e.show) ?? []), `S${e.season}E${e.number}`]);
for (const [show, eps] of bySeries) console.log(`  - ${show} : ${eps.length > 8 ? `${eps.slice(0, 8).join(', ')}… (${eps.length})` : eps.join(', ')}`);
console.log(`suivi : ${relations.followed} suivies, ${relations.shelved} de côté, ${relations.kept} déjà dans tes séries (inchangées)`);
console.log(`appels HTTP TMDB : ${tmdb.calls()}`);
