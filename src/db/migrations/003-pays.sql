-- Pays couverts par JustWatch (TMDB /watch/providers/regions), codes ISO 3166-1 alpha-2. Toutes les lignes ont le même fetched_at.
CREATE TABLE regions (
  code       TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;
