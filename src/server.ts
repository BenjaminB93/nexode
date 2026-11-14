import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './http/app.ts';
import { createCatalog } from './infra/catalog.ts';
import { createTmdb } from './infra/tmdb.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`migrations appliquées : ${applied.join(', ')}`);

// Sans jeton TMDB, l'appli tourne sur le cache seul (toute requête au catalogue répond 502).
const catalog = config.tmdbToken ? createCatalog({ db, tmdb: createTmdb({ token: config.tmdbToken }) }) : undefined;
if (!catalog) console.warn('TMDB_READ_TOKEN absent : catalogue en lecture seule');

// Compte 'dev' sans authentification, jamais en production (l'authentification arrive à l'étape 4).
const app = createApp({ db, catalog, devUser: config.env !== 'production' });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`écoute sur http://${info.address}:${info.port} (${config.env})`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
