import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import type { Catalog } from '../ports.ts';
import { HashBusyError } from '../infra/secrets.ts';
import { AppError, UpstreamError } from '../usecases/context.ts';
import { createApi } from './api.ts';
import { type AuthEnv, type Limits, createAuthRoutes, sessionMiddleware } from './auth.ts';
import { FailureLimiter, TooManyAttemptsError } from './rate-limit.ts';
import { MAX_BODY_BYTES } from './validate.ts';

export const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');

// catalog absent : les lectures en cache marchent, tout appel TMDB répond 502.
// siteUrl : origine publique (liens envoyés, contrôle d'Origin) ; en https, cookie Secure. production : cookie Secure, Origin comparé à siteUrl seul.
// trustProxy : l'adresse du client est lue dans X-Forwarded-For (derrière Caddy).
export type AppDeps = {
  db: Db; catalog?: Catalog; now?: () => Date; siteUrl?: string; production?: boolean; trustProxy?: boolean; limits?: Limits;
};

const STATUS: Record<string, ContentfulStatusCode> = {
  unauthorized: 401,
  invalid_credentials: 401,
  forbidden: 403,
  wrong_password: 403,
  invalid_input: 400,
  json_required: 400,
  invalid_json: 400,
  not_found: 404,
  invite_invalid: 404,
  reset_invalid: 404,
  not_aired: 409,
  username_taken: 409,
  invite_used: 409,
  is_admin: 409,
  last_admin: 409,
  too_many_attempts: 429,
  catalog_unavailable: 502,
};

const noCatalog = (): Promise<never> => Promise.reject(new UpstreamError('catalogue non configuré'));
const unavailableCatalog: Catalog = { ensureShow: noCatalog, refreshShow: noCatalog, ensureProviders: noCatalog, searchShows: noCatalog };

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Pages dont l'adresse contient un secret (code d'invitation, jeton de réinitialisation) : servies par le front.
const SECRET_PAGES = ['/invitation/:code', '/reinitialisation/:token'];

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono<AuthEnv>();
  const now = deps.now ?? (() => new Date());
  const siteUrl = new URL(deps.siteUrl ?? 'http://localhost:3000').origin;
  const production = deps.production ?? false;
  const secureCookie = production || siteUrl.startsWith('https:');
  const auth = {
    db: deps.db,
    now,
    secureCookie,
    trustProxy: deps.trustProxy ?? false,
    limits: deps.limits ?? { loginUser: new FailureLimiter(), loginIp: new FailureLimiter(), tokenIp: new FailureLimiter() },
  };

  // CSRF : une écriture venant d'une autre origine est refusée (en plus du JSON obligatoire et de SameSite=Lax).
  // Sans en-tête Origin (client hors navigateur), la requête passe : elle ne porte pas de cookie à l'insu de l'utilisateur.
  const originAllowed = (origin: string, c: Context) => {
    if (origin === siteUrl) return true;
    if (production) return false;
    try {
      return new URL(origin).host === new URL(c.req.url).host;
    } catch {
      return false;
    }
  };
  api.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (UNSAFE_METHODS.has(c.req.method) && origin !== undefined && !originAllowed(origin, c)) {
      return c.json({ error: 'bad_origin' }, 403);
    }
    await next();
  });
  // Refusé avant lecture complète : un corps énorme ne doit pas remplir la RAM du conteneur.
  api.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  api.get('/health', (c) => {
    deps.db.prepare('SELECT 1').get();
    return c.json({ ok: true });
  });
  api.use('*', sessionMiddleware(auth));
  api.route('/auth', createAuthRoutes(auth));
  api.route('/', createApi({
    db: deps.db,
    catalog: deps.catalog ?? unavailableCatalog,
    now,
    siteUrl,
    secureCookie,
    limits: auth.limits,
  }));

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  // Pas de Referer vers les ressources tierces (images TMDB) ni de mise en cache : l'adresse contient un secret.
  for (const path of SECRET_PAGES) {
    app.get(path, async (c) => {
      c.header('Referrer-Policy', 'no-referrer');
      c.header('Cache-Control', 'no-store');
      return c.html(await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8'));
    });
  }
  app.use('/*', serveStatic({ root: PUBLIC_DIR }));

  app.onError((thrown, c) => {
    // File de calculs scrypt pleine : même réponse qu'une limitation, à retenter tout de suite.
    const err = thrown instanceof HashBusyError ? new TooManyAttemptsError(1) : thrown;
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof AppError) {
      const status = STATUS[err.code] ?? 500;
      if (status >= 500) console.error(err.message);
      if (err instanceof TooManyAttemptsError) c.header('Retry-After', String(err.retryAfter));
      return c.json({ error: err.code, ...err.details }, status);
    }
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
