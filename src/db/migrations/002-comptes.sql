-- Comptes : sessions, invitations, réinitialisations. Jetons et codes stockés en SHA-256 (hex), jamais en clair.

-- Clé d'unicité du nom calculée par l'appli (NFC + minuscules) : COLLATE NOCASE ne replie que l'ASCII (« Élise » ≠ « élise »).
ALTER TABLE users ADD COLUMN username_key TEXT;
UPDATE users SET username_key = lower(username);
CREATE UNIQUE INDEX users_username_key ON users(username_key);

-- Durée glissante : expires_at est repoussé quand last_seen_at a plus d'un jour.
CREATE TABLE sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Statut calculé : used_at → utilisé ; revoked_at → révoqué ; expires_at passé → expiré ; sinon en attente.
-- created_by NULL = parrain supprimé ; used_at non NULL et used_by NULL = compte créé puis supprimé.
CREATE TABLE invites (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT    NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT,
  revoked_at TEXT
);
CREATE INDEX invites_created_by ON invites(created_by);
CREATE INDEX invites_used_by ON invites(used_by);

-- Un seul lien valide par compte : en créer un efface les précédents.
CREATE TABLE reset_tokens (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  used_at    TEXT
) WITHOUT ROWID;
CREATE INDEX reset_tokens_user ON reset_tokens(user_id);
