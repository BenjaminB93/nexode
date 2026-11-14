-- Notifications push (Web Push). Activées par appareil : une ligne = un navigateur abonné.

-- L'heure d'envoi reste réglée par compte ; l'activation se fait par appareil (push_subscriptions).
ALTER TABLE users DROP COLUMN notif_on;

-- endpoint : adresse d'envoi fournie par le navigateur (service push Google, Apple, Mozilla, Microsoft), unique par appareil.
-- Rattaché à la session qui l'a enregistré : déconnexion ou session expirée = plus de notifications sur cet appareil.
-- p256dh, auth : clés de chiffrement du navigateur (base64url).
CREATE TABLE push_subscriptions (
  endpoint     TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT    NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  p256dh       TEXT    NOT NULL,
  auth         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  seen_at      TEXT    NOT NULL
) WITHOUT ROWID;
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX push_subscriptions_session ON push_subscriptions(session_hash);

-- Une notification par série et par jour (jour local de l'utilisateur) : trace des envois, pour ne jamais doubler.
CREATE TABLE notifications_sent (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL,
  day     TEXT    NOT NULL,
  sent_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, day, show_id)
) WITHOUT ROWID;
