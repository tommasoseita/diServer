-- DiVoice organizations: one organization per deployment.
-- Only adds tables and columns, so an existing database keeps its members and data.

-- Organization settings as JSON values: "org" (name), "pipeline" (providers and models
-- per role), "team" (leaderboard on or off).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Provider API keys, encrypted with AES-GCM (key derived from DIVOICE_SECRET).
-- They are never returned by the API.
CREATE TABLE provider_keys (
  provider   TEXT PRIMARY KEY CHECK (provider IN ('mistral', 'openai')),
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Invites. "team": a link for anyone, or only for the listed addresses (emails, JSON array).
-- "personal": one use, with name and email filled in by the admin.
CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('team', 'personal')),
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  name       TEXT,
  email      TEXT,
  emails     TEXT,
  max_uses   INTEGER,
  uses       INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- A member can stay out of the team view and leaderboard.
ALTER TABLE users ADD COLUMN hide_from_team INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN invited_by TEXT;

-- Statistics without text: the member's local day and typing speed for "time saved".
ALTER TABLE dictation_events ADD COLUMN local_day TEXT;
ALTER TABLE dictation_events ADD COLUMN typing_wpm INTEGER;
CREATE INDEX events_user_day ON dictation_events (user_id, local_day);
