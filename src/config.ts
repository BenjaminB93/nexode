// Configuration lue une fois au démarrage, depuis l'environnement (.env en dev via --env-file-if-exists).

export type Config = {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dbPath: string;
  tmdbToken: string | undefined;
  siteUrl: string;        // origine publique, sans « / » final (liens d'invitation et de réinitialisation, contrôle d'Origin)
  trustProxy: boolean;    // derrière Caddy : adresse du client lue dans X-Forwarded-For
};

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
  return {
    env: mode,
    host: env.HOST || '127.0.0.1',
    port,
    dbPath: env.DB_PATH || 'data/app.sqlite',
    tmdbToken: env.TMDB_READ_TOKEN || undefined,
    siteUrl: site.origin,
    trustProxy: env.TRUST_PROXY === '1',
  };
}
