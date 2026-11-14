import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './http/app.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`migrations appliquées : ${applied.join(', ')}`);

const server = serve({ fetch: createApp({ db }).fetch, hostname: config.host, port: config.port }, (info) => {
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
