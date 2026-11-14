import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db/index.ts';
import { SESSION_TTL_MS, usernameKey } from '../domain/accounts.ts';
import { type Opened, closeSession, inviteInfo, login, resetInfo, resetPassword, resolveSession, signup } from '../usecases/auth.ts';
import type { User } from '../usecases/context.ts';
import { getMe } from '../usecases/settings.ts';
import { type FailureLimiter, clientIp, counting } from './rate-limit.ts';
import { jsonBody, noBody, str } from './validate.ts';

// Session par cookie et routes /api/auth (connexion, déconnexion, inscription par invitation, réinitialisation).

export type Session = { user: User; token: string };
export type AuthEnv = { Variables: { session: Session | null } };

export type Limits = {
  loginUser: FailureLimiter;   // échecs de connexion par nom (et mauvais mot de passe à la suppression du compte)
  loginIp: FailureLimiter;     // échecs de connexion par adresse
  tokenIp: FailureLimiter;     // codes d'invitation et liens de réinitialisation invalides, par adresse
};

export type AuthDeps = { db: Db; now: () => Date; secureCookie: boolean; trustProxy: boolean; limits: Limits };

export const SESSION_COOKIE = 'sid';

// secure : en production ou si SITE_URL est en https (en local, le site est servi en HTTP).
const cookieBase = (secure: boolean) => ({ httpOnly: true, sameSite: 'Lax', path: '/', secure }) as const;

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, { ...cookieBase(secure), maxAge: SESSION_TTL_MS / 1000 });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, cookieBase(secure));
}

// Lit le cookie : session valide → c.var.session ; cookie périmé ou inconnu → effacé. Prolongée → cookie renvoyé.
// Un seul Set-Cookie sid par réponse : celui posé par la route (connexion, déconnexion…) prime.
export function sessionMiddleware(deps: AuthDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    let session: Session | null = null;
    let cookie: 'clear' | 'extend' | null = null;
    if (token !== undefined) {
      const r = resolveSession({ db: deps.db, now: deps.now() }, token);
      if (!r) cookie = 'clear';
      else {
        session = { user: r.user, token };
        if (r.extended) cookie = 'extend';
      }
    }
    c.set('session', session);
    await next();
    if (cookie === null || c.res.headers.getSetCookie().some((v) => v.startsWith(`${SESSION_COOKIE}=`))) return;
    if (cookie === 'clear') clearSessionCookie(c, deps.secureCookie);
    else setSessionCookie(c, token as string, deps.secureCookie);
  };
}

export function createAuthRoutes(deps: AuthDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  const base = () => ({ db: deps.db, now: deps.now() });
  const ipCheck = (c: Context) => [[deps.limits.tokenIp, clientIp(c, deps.trustProxy)]] as [FailureLimiter, string][];

  // Ferme la session précédente éventuelle, pose le nouveau cookie, renvoie { me }.
  const started = (c: Context<AuthEnv>, opened: Opened, status: 200 | 201) => {
    const previous = c.get('session');
    if (previous) closeSession(base(), previous.token);
    setSessionCookie(c, opened.token, deps.secureCookie);
    return c.json({ me: getMe(deps.db, opened.userId) }, status);
  };

  r.post('/login', async (c) => {
    const body = await jsonBody(c, ['username', 'password']);
    const username = str(body.username, 'username');
    const password = str(body.password, 'password');
    const b = base();
    const userKey = usernameKey(username).slice(0, 64);
    const checks: [FailureLimiter, string][] = [[deps.limits.loginUser, userKey], [deps.limits.loginIp, clientIp(c, deps.trustProxy)]];
    const opened = await counting(checks, b.now.getTime(), ['invalid_credentials'], () => login(b, username, password));
    deps.limits.loginUser.reset(userKey);
    return started(c, opened, 200);
  });

  r.post('/logout', async (c) => {
    await noBody(c);
    const session = c.get('session');
    if (session) closeSession(base(), session.token);
    clearSessionCookie(c, deps.secureCookie);
    return c.body(null, 204);
  });

  r.get('/invite/:code', async (c) => {
    const b = base();
    return c.json(await counting(ipCheck(c), b.now.getTime(), ['invite_invalid'], () => inviteInfo(b, c.req.param('code'))));
  });

  r.post('/signup', async (c) => {
    const body = await jsonBody(c, ['code', 'username', 'password']);
    const code = str(body.code, 'code', 100);
    const username = str(body.username, 'username');
    const password = str(body.password, 'password');
    const b = base();
    const opened = await counting(ipCheck(c), b.now.getTime(), ['invite_invalid'], () => signup(b, code, username, password));
    return started(c, opened, 201);
  });

  r.get('/reset/:token', async (c) => {
    const b = base();
    return c.json(await counting(ipCheck(c), b.now.getTime(), ['reset_invalid'], () => resetInfo(b, c.req.param('token'))));
  });

  r.post('/reset', async (c) => {
    const body = await jsonBody(c, ['token', 'password']);
    const token = str(body.token, 'token', 100);
    const password = str(body.password, 'password');
    const b = base();
    const opened = await counting(ipCheck(c), b.now.getTime(), ['reset_invalid'], () => resetPassword(b, token, password));
    return started(c, opened, 200);
  });

  return r;
}
