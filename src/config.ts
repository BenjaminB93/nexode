// Configuration lue une fois au démarrage, depuis l'environnement (.env en dev via --env-file-if-exists).

export type Config = {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dbPath: string;
  tmdbToken: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development';
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT invalide : ${env.PORT}`);
  return {
    env: mode,
    host: env.HOST || '127.0.0.1',
    port,
    dbPath: env.DB_PATH || 'data/app.sqlite',
    tmdbToken: env.TMDB_READ_TOKEN || undefined,
  };
}
