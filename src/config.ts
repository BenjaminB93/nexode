// Configuration lue une fois au démarrage, depuis l'environnement (.env en dev via --env-file-if-exists).

export type Config = {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dbPath: string;
  tmdbToken: string | undefined;
  siteUrl: string;        // origine publique, sans « / » final (liens d'invitation et de réinitialisation, contrôle d'Origin)
  trustProxy: boolean;    // derrière Caddy : adresse du client lue dans X-Forwarded-For
  vapid: Vapid | undefined; // absent : notifications désactivées
};

// Clés VAPID (base64url, générées par src/cli/vapid-keys.ts) ; subject : contact transmis aux services push.
export type Vapid = { publicKey: string; privateKey: string; subject: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development';
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT invalide : ${env.PORT}`);
  let site: URL;
  try {
    site = new URL(env.SITE_URL || 'http://localhost:3000');
  } catch {
    throw new Error(`SITE_URL invalide : ${env.SITE_URL}`);
  }
  if (!['http:', 'https:'].includes(site.protocol) || site.pathname !== '/' || site.search || site.hash) {
    throw new Error(`SITE_URL doit être une origine (ex. https://series.exemple.fr) : ${env.SITE_URL}`);
  }
  const pub = env.VAPID_PUBLIC_KEY || undefined;
  const priv = env.VAPID_PRIVATE_KEY || undefined;
  if (!pub !== !priv) throw new Error('VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY vont ensemble');
  if (pub && !/^[A-Za-z0-9_-]{87}$/.test(pub)) throw new Error('VAPID_PUBLIC_KEY invalide');
  if (priv && !/^[A-Za-z0-9_-]{43}$/.test(priv)) throw new Error('VAPID_PRIVATE_KEY invalide');
  // Les services push exigent une adresse https: ou mailto: ; le site lui-même convient en production.
  const subject = env.VAPID_SUBJECT || (site.protocol === 'https:' ? site.origin : 'mailto:notifications@localhost.invalid');
  if (!subject.startsWith('https://') && !subject.startsWith('mailto:')) {
    throw new Error(`VAPID_SUBJECT doit commencer par https:// ou mailto: : ${subject}`);
  }
  return {
    env: mode,
    host: env.HOST || '127.0.0.1',
    port,
    dbPath: env.DB_PATH || 'data/app.sqlite',
    tmdbToken: env.TMDB_READ_TOKEN || undefined,
    siteUrl: site.origin,
    trustProxy: env.TRUST_PROXY === '1',
    vapid: pub && priv ? { publicKey: pub, privateKey: priv, subject } : undefined,
  };
}
