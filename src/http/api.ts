import { Hono } from 'hono';
import type { Db } from '../db/index.ts';
import type { Catalog } from '../ports.ts';
import { RELATIONS } from '../domain/series.ts';
import { ensureUser } from '../infra/repos.ts';
import { type Ctx, AppError, InvalidInputError } from '../usecases/context.ts';
import { HISTORY_PAGE, decodeCursor, history, myShows, shelf, timeline } from '../usecases/lists.ts';
import { setRelation } from '../usecases/relation.ts';
import { search } from '../usecases/search.ts';
import { COUNTRIES, SHELVE_AFTER_DAYS, type SettingsPatch, getSettings, updateSettings } from '../usecases/settings.ts';
import { seasonDetail, showDetail } from '../usecases/show.ts';
import { type MarkEntry, markSeason, markWatched, unmarkWatched, watchedUntil } from '../usecases/watched.ts';
import { MAX_BATCH, bool, idList, instant, intOneOf, intRange, jsonBody, jsonId, oneOf, positiveId } from './validate.ts';

export type ApiDeps = { db: Db; catalog: Catalog; devUser: boolean; now: () => Date };

export const DEV_USERNAME = 'dev';

// Routes JSON authentifiées (montées sous /api). Les écritures renvoient l'état recalculé de la série concernée.
export function createApi(deps: ApiDeps): Hono {
  const api = new Hono();

  // Utilisateur courant. Sans authentification (étape 4), seul le compte de développement existe.
  const ctxOf = (): Ctx => {
    if (!deps.devUser) throw new AppError('unauthorized', 'connexion requise');
    const now = deps.now();
    const u = ensureUser(deps.db, DEV_USERNAME, now.toISOString());
    return {
      db: deps.db,
      catalog: deps.catalog,
      now,
      user: { id: u.id, country: u.country, timezone: u.timezone, shelveAfterDays: u.shelveAfterDays },
    };
  };

  api.get('/me', (c) => c.json(getSettings(ctxOf())));

  // Champs facultatifs ; tout est validé avant la moindre écriture.
  api.patch('/me', async (c) => {
    const ctx = ctxOf();
    const body = await jsonBody(c, ['country', 'shelveAfterDays', 'notifOn', 'notifHour']);
    const patch: SettingsPatch = {};
    if (body.country !== undefined) patch.country = oneOf(body.country, COUNTRIES, 'country');
    if (body.shelveAfterDays !== undefined) patch.shelveAfterDays = intOneOf(body.shelveAfterDays, SHELVE_AFTER_DAYS, 'shelveAfterDays');
    if (body.notifOn !== undefined) patch.notifOn = bool(body.notifOn, 'notifOn');
    if (body.notifHour !== undefined) patch.notifHour = intRange(body.notifHour, 0, 23, 'notifHour');
    return c.json(updateSettings(ctx, patch));
  });

  api.get('/timeline', (c) => c.json(timeline(ctxOf())));

  api.get('/history', (c) => {
    const ctx = ctxOf();
    const before = c.req.query('before');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? HISTORY_PAGE : positiveId(limitRaw, 'limit');
    if (limit > 100) throw new InvalidInputError('limit');
    return c.json(history(ctx, before ? decodeCursor(before) : null, limit));
  });

  api.get('/shelf', (c) => c.json(shelf(ctxOf())));

  api.get('/my-shows', (c) => c.json({ shows: myShows(ctxOf()) }));

  api.get('/search', async (c) => {
    const ctx = ctxOf();
    const q = (c.req.query('q') ?? '').trim();
    if (!q || q.length > 100) throw new InvalidInputError('q');
    return c.json({ results: await search(ctx, q) });
  });

  api.get('/shows/:id', async (c) => {
    const ctx = ctxOf();
    return c.json(await showDetail(ctx, positiveId(c.req.param('id'), 'id')));
  });

  api.get('/shows/:id/seasons/:n', async (c) => {
    const ctx = ctxOf();
    return c.json(await seasonDetail(ctx, positiveId(c.req.param('id'), 'id'), positiveId(c.req.param('n'), 'n')));
  });

  api.put('/shows/:id/relation', async (c) => {
    const ctx = ctxOf();
    const showId = positiveId(c.req.param('id'), 'id');
    const body = await jsonBody(c, ['to']);
    return c.json({ show: await setRelation(ctx, showId, oneOf(body.to, RELATIONS, 'to')) });
  });

  api.put('/watched/:episodeId', async (c) => {
    const ctx = ctxOf();
    const episodeId = positiveId(c.req.param('episodeId'), 'episodeId');
    const body = await jsonBody(c, ['watchedAt']);
    const watchedAt = body.watchedAt === undefined ? undefined : instant(body.watchedAt, 'watchedAt', ctx.now);
    const { marked, shows } = markWatched(ctx, [{ episodeId, watchedAt }]);
    return c.json({ marked, show: shows[0] });
  });

  api.delete('/watched/:episodeId', (c) => {
    const ctx = ctxOf();
    const { removed, shows } = unmarkWatched(ctx, [positiveId(c.req.param('episodeId'), 'episodeId')]);
    return c.json({ removed, show: shows[0] });
  });

  // { on, episodeIds, watchedAt? } ou, pour annuler une remise en non vu, { on: true, restore: [{ episodeId, watchedAt }] }.
  api.post('/watched/batch', async (c) => {
    const ctx = ctxOf();
    const body = await jsonBody(c, ['on', 'episodeIds', 'watchedAt', 'restore']);
    const on = bool(body.on, 'on');
    if (body.restore !== undefined) {
      if (!on || body.episodeIds !== undefined || body.watchedAt !== undefined) throw new InvalidInputError('restore');
      return c.json(markWatched(ctx, restoreEntries(body.restore, ctx.now)));
    }
    const episodeIds = idList(body.episodeIds, 'episodeIds');
    if (!on) {
      if (body.watchedAt !== undefined) throw new InvalidInputError('watchedAt');
      return c.json(unmarkWatched(ctx, episodeIds));
    }
    const watchedAt = body.watchedAt === undefined ? undefined : instant(body.watchedAt, 'watchedAt', ctx.now);
    return c.json(markWatched(ctx, episodeIds.map((episodeId) => ({ episodeId, watchedAt }))));
  });

  api.post('/shows/:id/watched-until', async (c) => {
    const ctx = ctxOf();
    const showId = positiveId(c.req.param('id'), 'id');
    const body = await jsonBody(c, ['episodeId']);
    return c.json(watchedUntil(ctx, showId, jsonId(body.episodeId, 'episodeId')));
  });

  api.post('/shows/:id/seasons/:n/watched', async (c) => {
    const ctx = ctxOf();
    const showId = positiveId(c.req.param('id'), 'id');
    const n = positiveId(c.req.param('n'), 'n');
    await jsonBody(c, []);
    return c.json(markSeason(ctx, showId, n));
  });

  return api;
}

function restoreEntries(raw: unknown, now: Date): MarkEntry[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH) throw new InvalidInputError('restore');
  return raw.map((x: unknown) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new InvalidInputError('restore');
    const { episodeId, watchedAt, ...rest } = x as Record<string, unknown>;
    if (Object.keys(rest).length) throw new InvalidInputError('restore');
    return { episodeId: jsonId(episodeId, 'restore'), watchedAt: instant(watchedAt, 'restore', now) };
  });
}
