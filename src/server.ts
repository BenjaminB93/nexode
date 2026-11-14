import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './http/app.ts';
import { createCatalog } from './infra/catalog.ts';
import { createScheduler } from './infra/scheduler.ts';
import { createTmdb } from './infra/tmdb.ts';
import { dailyMaintenance, describePurge, describeRefresh } from './usecases/refresh.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`migrations appliquées : ${applied.join(', ')}`);

// Sans jeton TMDB, l'appli tourne sur le cache seul (toute requête au catalogue répond 502).
const tmdb = config.tmdbToken ? createTmdb({ token: config.tmdbToken }) : undefined;
const catalog = tmdb && createCatalog({ db, tmdb });
if (!catalog) console.warn('TMDB_READ_TOKEN absent : catalogue en lecture seule, pas de rafraîchissement quotidien (la purge tourne)');

if (config.env === 'production' && !config.siteUrl.startsWith('https://')) console.warn(`SITE_URL n'est pas en HTTPS : ${config.siteUrl}`);
if (config.env !== 'production' && config.siteUrl.startsWith('https://')) console.warn(`SITE_URL est en HTTPS mais NODE_ENV n'est pas production (${config.env}) : mettre NODE_ENV=production.`);

const app = createApp({ db, catalog, siteUrl: config.siteUrl, production: config.env === 'production', trustProxy: config.trustProxy });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`écoute sur http://${info.address}:${info.port} (${config.env})`);
});

const scheduler = createScheduler();
scheduler.daily('maintenance', '04:30', async (signal) => {
  const calls = tmdb?.calls() ?? 0;
  const r = await dailyMaintenance({ db, catalog, signal });
  const refresh = r.refresh ? `, ${describeRefresh(r.refresh)}, ${(tmdb?.calls() ?? 0) - calls} appels TMDB` : '';
  console.log(`maintenance : ${describePurge(r.purgedResets)}${refresh}`);
});

// Arrêt : plus de nouvelle tâche ni connexion ; la tâche en cours s'arrête entre deux séries, les requêtes en cours finissent.
// Au plus tard après SHUTDOWN_MS (Docker tue à 10 s), sortie forcée. Un second signal sort tout de suite.
const SHUTDOWN_MS = 8000;
let stopping = false;
function exit(code: number): void {
  db.close();
  process.exit(code);
}
function shutdown(): void {
  if (stopping) return exit(1);
  stopping = true;
  setTimeout(() => {
    console.warn(`arrêt forcé après ${SHUTDOWN_MS / 1000} s : tâche ou requête encore en cours`);
    exit(1);
  }, SHUTDOWN_MS);
  void Promise.all([scheduler.stop(), new Promise((resolve) => server.close(resolve))]).then(() => exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
