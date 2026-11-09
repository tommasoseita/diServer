-- diMail on the organization server. Only adds tables and columns, so an existing database
-- keeps its members and data, and diVoice keeps working unchanged.

-- More than one token per member: one for each app and Mac. diVoice's token stays in
-- users.token_hash; diMail's tokens live here.
CREATE TABLE member_tokens (
  hash         TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app          TEXT NOT NULL CHECK (app IN ('divoice', 'dimail')),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX member_tokens_user ON member_tokens (user_id);

-- Whether users.token_hash is a real diVoice token. Members who joined from diMail get a hash
-- nobody holds, and 0 here.
ALTER TABLE users ADD COLUMN legacy_token INTEGER NOT NULL DEFAULT 1;

-- Which app an invite is for: its page and download.
ALTER TABLE invites ADD COLUMN app TEXT NOT NULL DEFAULT 'divoice';

-- diMail's secrets, encrypted like the provider keys: "mail.google_client_secret", "mail.ai_key".
CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
