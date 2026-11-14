// Lance tout de suite la maintenance quotidienne (purge, puis rafraîchissement TMDB des séries suivies ou de côté).
// Usage : node --env-file-if-exists=.env src/cli/refresh.ts
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { createCatalog } from '../infra/catalog.ts';
import { createTmdb } from '../infra/tmdb.ts';
import { dailyMaintenance, describePurge, describeRefresh } from '../usecases/refresh.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);
const tmdb = config.tmdbToken ? createTmdb({ token: config.tmdbToken }) : undefined;
if (!tmdb) console.warn('TMDB_READ_TOKEN absent : purge seule, pas de rafraîchissement.');

const report = await dailyMaintenance({ db, catalog: tmdb && createCatalog({ db, tmdb }) });
db.close();

console.log(describePurge(report.purgedResets));
if (report.refresh) console.log(`${describeRefresh(report.refresh)}, ${tmdb?.calls() ?? 0} appels HTTP TMDB`);
process.exitCode = report.purgedResets === null || !report.refresh || report.refresh.failed ? 1 : 0;
