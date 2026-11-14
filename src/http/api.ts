import { type Context, Hono } from 'hono';
import type { Db } from '../db/index.ts';
import type { Catalog } from '../ports.ts';
import { ASSIGNABLE_ROLES, usernameKey } from '../domain/accounts.ts';
import { RELATIONS } from '../domain/series.ts';
import { deleteMe, exportData } from '../usecases/account.ts';
import { createResetLink, deleteUser, listUsers, setRole } from '../usecases/admin.ts';
import { type Ctx, AppError, InvalidInputError } from '../usecases/context.ts';
import { createInvite, listInvites, revokeInvite } from '../usecases/invites.ts';
import { HISTORY_PAGE, decodeCursor, history, myShows, shelf, timeline } from '../usecases/lists.ts';
import { setRelation } from '../usecases/relation.ts';
import { search } from '../usecases/search.ts';
import { COUNTRIES, SHELVE_AFTER_DAYS, type SettingsPatch, getSettings, updateSettings } from '../usecases/settings.ts';
import { seasonDetail, showDetail } from '../usecases/show.ts';
import { type MarkEntry, markSeason, markWatched, unmarkWatched, watchedUntil } from '../usecases/watched.ts';
import { type AuthEnv, type Limits, clearSessionCookie } from './auth.ts';
import { counting } from './rate-limit.ts';
import { MAX_BATCH, bool, idList, instant, intOneOf, intRange, jsonBody, jsonId, noBody, oneOf, positiveId, str } from './validate.ts';

// siteUrl : origine publique du site (liens d'invitation et de réinitialisation).
export type ApiDeps = { db: Db; catalog: Catalog; now: () => Date; siteUrl: string; secureCookie: boolean; limits: Limits };

// Routes JSON authentifiées (montées sous /api, après le middleware de session). Les écritures renvoient l'état recalculé de la série concernée.
export function createApi(deps: ApiDeps): Hono<AuthEnv> {
  const api = new Hono<AuthEnv>();

  const ctxOf = (c: Context<AuthEnv>): Ctx => {
    const session = c.get('session');
    if (!session) throw new AppError('unauthorized', 'connexion requise');
    return { db: deps.db, catalog: deps.catalog, now: deps.now(), user: session.user };
  };

  api.get('/me', (c) => c.json(getSettings(ctxOf(c))));

  // Champs facultatifs ; tout est validé avant la moindre écriture.
  api.patch('/me', async (c) => {
    const ctx = ctxOf(c);
    const body = await jsonBody(c, ['country', 'shelveAfterDays', 'notifOn', 'notifHour']);
    const patch: SettingsPatch = {};
    if (body.country !== undefined) patch.country = oneOf(body.country, COUNTRIES, 'country');
    if (body.shelveAfterDays !== undefined) patch.shelveAfterDays = intOneOf(body.shelveAfterDays, SHELVE_AFTER_DAYS, 'shelveAfterDays');
    if (body.notifOn !== undefined) patch.notifOn = bool(body.notifOn, 'notifOn');
    if (body.notifHour !== undefined) patch.notifHour = intRange(body.notifHour, 0, 23, 'notifHour');
    return c.json(updateSettings(ctx, patch));
  });

  // Mot de passe ressaisi ; les échecs comptent comme des échecs de connexion sur ce nom.
  api.delete('/me', async (c) => {
    const ctx = ctxOf(c);
    const body = await jsonBody(c, ['password']);
    const password = str(body.password, 'password');
    const key = usernameKey(getSettings(ctx).username);
    await counting([[deps.limits.loginUser, key]], ctx.now.getTime(), ['wrong_password'], () => deleteMe(ctx, password));
    clearSessionCookie(c, deps.secureCookie);
    return c.body(null, 204);
  });

  api.get('/me/export', (c) => {
    const { filename, data } = exportData(ctxOf(c));
    return c.body(JSON.stringify(data, null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
  });

  // ---------- parrainages ----------

  api.get('/invites', (c) => c.json({ invites: listInvites(ctxOf(c)) }));

  // Le lien complet n'est renvoyé qu'ici : seul le hash du code est stocké.
  api.post('/invites', async (c) => {
    const ctx = ctxOf(c);
    await noBody(c);
    const { invite, code } = createInvite(ctx);
    return c.json({ invite, url: `${deps.siteUrl}/invitation/${code}` }, 201);
  });

  api.delete('/invites/:id', async (c) => {
    const ctx = ctxOf(c);
    const id = positiveId(c.req.param('id'), 'id');
    await noBody(c);
    revokeInvite(ctx, id);
    return c.body(null, 204);
  });

  // ---------- comptes (admin) ----------

  api.get('/admin/users', (c) => c.json({ users: listUsers(ctxOf(c)) }));

  api.put('/admin/users/:id/role', async (c) => {
    const ctx = ctxOf(c);
    const id = positiveId(c.req.param('id'), 'id');
    const body = await jsonBody(c, ['role']);
    return c.json({ user: setRole(ctx, id, oneOf(body.role, ASSIGNABLE_ROLES, 'role')) });
  });

  api.post('/admin/users/:id/reset', async (c) => {
    const ctx = ctxOf(c);
    const id = positiveId(c.req.param('id'), 'id');
    await noBody(c);
    const { token, expiresAt } = createResetLink(ctx, id);
    return c.json({ url: `${deps.siteUrl}/reinitialisation/${token}`, expiresAt }, 201);
  });

  api.delete('/admin/users/:id', async (c) => {
    const ctx = ctxOf(c);
    const id = positiveId(c.req.param('id'), 'id');
    await noBody(c);
    deleteUser(ctx, id);
    return c.body(null, 204);
  });

  // ---------- séries ----------

  api.get('/timeline', (c) => c.json(timeline(ctxOf(c))));

  api.get('/history', (c) => {
    const ctx = ctxOf(c);
    const before = c.req.query('before');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? HISTORY_PAGE : positiveId(limitRaw, 'limit');
    if (limit > 100) throw new InvalidInputError('limit');
    return c.json(history(ctx, before ? decodeCursor(before) : null, limit));
  });

  api.get('/shelf', (c) => c.json(shelf(ctxOf(c))));

  api.get('/my-shows', (c) => c.json({ shows: myShows(ctxOf(c)) }));

  api.get('/search', async (c) => {
    const ctx = ctxOf(c);
    const q = (c.req.query('q') ?? '').trim();
    if (!q || q.length > 100) throw new InvalidInputError('q');
    return c.json({ results: await search(ctx, q) });
  });

  api.get('/shows/:id', async (c) => {
    const ctx = ctxOf(c);
    return c.json(await showDetail(ctx, positiveId(c.req.param('id'), 'id')));
  });

  api.get('/shows/:id/seasons/:n', async (c) => {
    const ctx = ctxOf(c);
    return c.json(await seasonDetail(ctx, positiveId(c.req.param('id'), 'id'), positiveId(c.req.param('n'), 'n')));
  });

  api.put('/shows/:id/relation', async (c) => {
    const ctx = ctxOf(c);
    const showId = positiveId(c.req.param('id'), 'id');
    const body = await jsonBody(c, ['to']);
    return c.json({ show: await setRelation(ctx, showId, oneOf(body.to, RELATIONS, 'to')) });
  });

  api.put('/watched/:episodeId', async (c) => {
    const ctx = ctxOf(c);
    const episodeId = positiveId(c.req.param('episodeId'), 'episodeId');
    const body = await jsonBody(c, ['watchedAt']);
    const watchedAt = body.watchedAt === undefined ? undefined : instant(body.watchedAt, 'watchedAt', ctx.now);
    const { marked, shows } = markWatched(ctx, [{ episodeId, watchedAt }]);
    return c.json({ marked, show: shows[0] });
  });

  api.delete('/watched/:episodeId', (c) => {
    const ctx = ctxOf(c);
    const { removed, shows } = unmarkWatched(ctx, [positiveId(c.req.param('episodeId'), 'episodeId')]);
    return c.json({ removed, show: shows[0] });
  });

  // { on, episodeIds, watchedAt? } ou, pour annuler une remise en non vu, { on: true, restore: [{ episodeId, watchedAt }] }.
  api.post('/watched/batch', async (c) => {
    const ctx = ctxOf(c);
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
    const ctx = ctxOf(c);
    const showId = positiveId(c.req.param('id'), 'id');
    const body = await jsonBody(c, ['episodeId']);
    return c.json(watchedUntil(ctx, showId, jsonId(body.episodeId, 'episodeId')));
  });

  api.post('/shows/:id/seasons/:n/watched', async (c) => {
    const ctx = ctxOf(c);
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
