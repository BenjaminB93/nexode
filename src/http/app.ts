import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';

export const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');

export type AppDeps = { db: Db };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();

  api.get('/health', (c) => {
    deps.db.prepare('SELECT 1').get();
    return c.json({ ok: true });
  });

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  app.use('/*', serveStatic({ root: PUBLIC_DIR }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
