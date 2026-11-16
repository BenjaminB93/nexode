-- Épisodes remis en non vu récemment : date et provenance d'origine, gardées quelques minutes.
-- Recocher dans ce délai rend le visionnage tel qu'il était (erreur de manipulation corrigée) ; au-delà, la ligne est purgée.
CREATE TABLE unwatched_recent (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  watched_at TEXT    NOT NULL,
  single     INTEGER NOT NULL CHECK (single IN (0, 1)),
  removed_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, episode_id)
) WITHOUT ROWID;
