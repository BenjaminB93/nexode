-- Dates : jours en 'YYYY-MM-DD' ; instants en ISO 8601 UTC ('YYYY-MM-DDTHH:MM:SS.sssZ').

-- Comptes (sessions, invitations et réinitialisations : étape 4).
CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  username          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash           TEXT    NOT NULL,                       -- '!' = compte sans mot de passe utilisable
  role              TEXT    NOT NULL DEFAULT 'membre' CHECK (role IN ('membre', 'parrain', 'admin')),
  invited_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  country           TEXT    NOT NULL DEFAULT 'FR',
  shelve_after_days INTEGER NOT NULL DEFAULT 30 CHECK (shelve_after_days > 0),
  notif_on          INTEGER NOT NULL DEFAULT 1 CHECK (notif_on IN (0, 1)),
  notif_hour        INTEGER NOT NULL DEFAULT 9 CHECK (notif_hour BETWEEN 0 AND 23),
  timezone          TEXT    NOT NULL DEFAULT 'Europe/Paris',
  created_at        TEXT    NOT NULL
);

-- Catalogue : cache local des données TMDB. Saison 0 (épisodes spéciaux) non importée.
CREATE TABLE shows (
  id                INTEGER PRIMARY KEY,                    -- id TMDB
  name              TEXT    NOT NULL,                       -- titre FR, sinon titre original
  original_name     TEXT    NOT NULL,
  original_language TEXT    NOT NULL,
  overview          TEXT    NOT NULL DEFAULT '',
  first_air_date    TEXT,
  status            TEXT    NOT NULL CHECK (status IN ('returning', 'ended', 'canceled', 'in_production', 'planned', 'pilot', 'unknown')),
  poster_path       TEXT,
  tvdb_id           INTEGER,
  refreshed_at      TEXT    NOT NULL
);
CREATE INDEX shows_tvdb_id ON shows(tvdb_id);

CREATE TABLE seasons (
  show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL CHECK (number >= 1),
  name        TEXT    NOT NULL,
  overview    TEXT    NOT NULL DEFAULT '',
  air_date    TEXT,
  poster_path TEXT,
  PRIMARY KEY (show_id, number)
);

CREATE TABLE episodes (
  id          INTEGER PRIMARY KEY,                          -- id TMDB
  show_id     INTEGER NOT NULL,
  season      INTEGER NOT NULL,
  number      INTEGER NOT NULL,
  title       TEXT,                                         -- NULL = titre pas encore annoncé
  title_is_vo INTEGER NOT NULL DEFAULT 0 CHECK (title_is_vo IN (0, 1)),
  overview    TEXT    NOT NULL DEFAULT '',
  air_date    TEXT,                                         -- NULL = date inconnue
  runtime     INTEGER,
  still_path  TEXT,
  UNIQUE (show_id, season, number),
  FOREIGN KEY (show_id, season) REFERENCES seasons(show_id, number) ON DELETE CASCADE
);
CREATE INDEX episodes_air_date ON episodes(air_date);

-- Où regarder (JustWatch via TMDB), par saison et par pays. provider_fetches garde la date de relevé même quand la liste est vide.
CREATE TABLE provider_fetches (
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season     INTEGER NOT NULL,
  country    TEXT    NOT NULL,
  fetched_at TEXT    NOT NULL,
  PRIMARY KEY (show_id, season, country)
);
CREATE TABLE providers (
  show_id     INTEGER NOT NULL,
  season      INTEGER NOT NULL,
  country     TEXT    NOT NULL,
  provider_id INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  logo_path   TEXT,
  priority    INTEGER NOT NULL,
  PRIMARY KEY (show_id, season, country, provider_id),
  FOREIGN KEY (show_id, season, country) REFERENCES provider_fetches(show_id, season, country) ON DELETE CASCADE
);

-- Suivi. Pas de ligne = série pas suivie. La mise de côté par inactivité n'est pas stockée : elle se calcule.
CREATE TABLE user_shows (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id    INTEGER NOT NULL REFERENCES shows(id),
  state      TEXT    NOT NULL CHECK (state IN ('followed', 'shelved')),   -- 'shelved' = mise de côté manuelle
  added_at   TEXT    NOT NULL,
  resumed_at TEXT,                                          -- dernier retour explicite sur « En cours »
  PRIMARY KEY (user_id, show_id)
);
CREATE INDEX user_shows_show ON user_shows(show_id);

-- Historique de visionnage : indépendant du suivi, jamais effacé par un changement de suivi.
-- Un épisode vu ne peut pas disparaître du catalogue (pas de CASCADE) : le rafraîchissement doit le conserver.
CREATE TABLE watched (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  watched_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, episode_id)
);
CREATE INDEX watched_user_time ON watched(user_id, watched_at);
