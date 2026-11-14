import { type Db, openDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { Catalog, SearchResult } from '../../src/ports.ts';
import type { Ctx, User } from '../../src/usecases/context.ts';
import { ensureUser } from '../../src/infra/repos.ts';

// Série de test : dates de sortie par saison et par épisode (null = date inconnue).
export type ShowFixture = {
  id: number;
  name: string;
  status?: string;                                 // shows.status, défaut 'returning'
  firstAirDate?: string;
  seasons: (string | null)[][];
  providers?: Record<string, number[][]>;          // pays → ids de plateformes par saison
};

// Id d'épisode déterministe : 1001203 = série 1001, saison 2, épisode 3.
export const epId = (showId: number, season: number, number: number) => showId * 1000 + season * 100 + number;

export function testDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

export function seedShow(db: Db, fx: ShowFixture, refreshedAt = '2026-01-01T00:00:00.000Z'): void {
  db.prepare(`INSERT INTO shows (id, name, original_name, original_language, overview, first_air_date, status, poster_path, refreshed_at)
    VALUES (?, ?, ?, 'en', ?, ?, ?, ?, ?)`)
    .run(fx.id, fx.name, fx.name, `Résumé de ${fx.name}`, fx.firstAirDate ?? fx.seasons[0]?.[0] ?? null, fx.status ?? 'returning', `/p${fx.id}.jpg`, refreshedAt);
  fx.seasons.forEach((dates, i) => {
    const s = i + 1;
    db.prepare('INSERT INTO seasons (show_id, number, name, air_date) VALUES (?, ?, ?, ?)').run(fx.id, s, `Saison ${s}`, dates[0] ?? null);
    dates.forEach((d, j) => {
      const e = j + 1;
      db.prepare(`INSERT INTO episodes (id, show_id, season, number, title, title_is_vo, air_date, runtime)
        VALUES (?, ?, ?, ?, ?, ?, ?, 50)`).run(epId(fx.id, s, e), fx.id, s, e, `Épisode ${s}x${e}`, e === 1 ? 1 : 0, d);
    });
  });
}

// Faux catalogue : insère directement les séries connues en base, sans réseau.
export class FakeCatalog implements Catalog {
  readonly db: Db;
  readonly fixtures: Map<number, ShowFixture>;
  readonly calls: string[] = [];
  offline = false;

  constructor(db: Db, fixtures: readonly ShowFixture[]) {
    this.db = db;
    this.fixtures = new Map(fixtures.map((f) => [f.id, f]));
  }

  async ensureShow(showId: number): Promise<void> {
    this.calls.push(`ensureShow ${showId}`);
    if (this.offline) throw new Error('réseau coupé');
    const fx = this.fixtures.get(showId);
    if (!fx) throw Object.assign(new Error('TMDB 404'), { status: 404 });
    if (!this.db.prepare('SELECT 1 FROM shows WHERE id = ?').get(showId)) seedShow(this.db, fx);
  }

  async refreshShow(showId: number): Promise<void> {
    await this.ensureShow(showId);
  }

  async ensureProviders(showId: number, country: string): Promise<void> {
    this.calls.push(`ensureProviders ${showId} ${country}`);
    if (this.offline) throw new Error('réseau coupé');
    const perSeason = this.fixtures.get(showId)?.providers?.[country];
    if (!perSeason) return;
    perSeason.forEach((providerIds, i) => {
      const season = i + 1;
      this.db.prepare(`INSERT OR REPLACE INTO provider_fetches (show_id, season, country, fetched_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`)
        .run(showId, season, country);
      providerIds.forEach((pid, priority) => {
        this.db.prepare(`INSERT OR IGNORE INTO providers (show_id, season, country, provider_id, name, logo_path, priority) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(showId, season, country, pid, `Plateforme ${pid}`, `/l${pid}.png`, priority);
      });
    });
  }

  async searchShows(query: string): Promise<SearchResult[]> {
    this.calls.push(`searchShows ${query}`);
    if (this.offline) throw new Error('réseau coupé');
    const q = query.toLowerCase();
    return [...this.fixtures.values()]
      .filter((f) => f.name.toLowerCase().includes(q))
      .map((f) => ({ id: f.id, name: f.name, year: Number((f.firstAirDate ?? f.seasons[0]?.[0] ?? '0').slice(0, 4)) || null, posterPath: `/p${f.id}.jpg` }));
  }
}

// Contexte de use case : utilisateur 'dev' (Europe/Paris, seuil 30 j par défaut), instant now réglable.
export function makeCtx(db: Db, catalog: Catalog, now: string, settings: Partial<Pick<User, 'timezone' | 'shelveAfterDays' | 'country'>> = {}): Ctx {
  const u = ensureUser(db, 'dev', now);
  if (settings.timezone) db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(settings.timezone, u.id);
  if (settings.shelveAfterDays) db.prepare('UPDATE users SET shelve_after_days = ? WHERE id = ?').run(settings.shelveAfterDays, u.id);
  if (settings.country) db.prepare('UPDATE users SET country = ? WHERE id = ?').run(settings.country, u.id);
  const row = ensureUser(db, 'dev', now);
  return { db, catalog, now: new Date(now), user: { id: row.id, country: row.country, timezone: row.timezone, shelveAfterDays: row.shelveAfterDays } };
}
