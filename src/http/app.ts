import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import type { Catalog } from '../ports.ts';
import { AppError, InvalidInputError, UpstreamError } from '../usecases/context.ts';
import { createApi } from './api.ts';
import { MAX_BODY_BYTES } from './validate.ts';

export const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');

// catalog absent : les lectures en cache marchent, tout appel TMDB répond 502.
// devUser : tant que l'authentification n'existe pas, toutes les requêtes passent par un compte 'dev' ; sinon 401.
export type AppDeps = { db: Db; catalog?: Catalog; devUser?: boolean; now?: () => Date };

const STATUS: Record<string, ContentfulStatusCode> = {
  unauthorized: 401,
  invalid_input: 400,
  json_required: 400,
  invalid_json: 400,
  not_found: 404,
  not_aired: 409,
  catalog_unavailable: 502,
};

const noCatalog = (): Promise<never> => Promise.reject(new UpstreamError('catalogue non configuré'));
const unavailableCatalog: Catalog = { ensureShow: noCatalog, refreshShow: noCatalog, ensureProviders: noCatalog, searchShows: noCatalog };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();

  // Refusé avant lecture complète : un corps énorme ne doit pas remplir la RAM du conteneur.
  api.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  api.get('/health', (c) => {
    deps.db.prepare('SELECT 1').get();
    return c.json({ ok: true });
  });
  api.route('/', createApi({
    db: deps.db,
    catalog: deps.catalog ?? unavailableCatalog,
    devUser: deps.devUser ?? false,
    now: deps.now ?? (() => new Date()),
  }));

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  app.use('/*', serveStatic({ root: PUBLIC_DIR }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof AppError) {
      const status = STATUS[err.code] ?? 500;
      if (status >= 500) console.error(err.message);
      return c.json(err instanceof InvalidInputError ? { error: err.code, field: err.field } : { error: err.code }, status);
    }
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
