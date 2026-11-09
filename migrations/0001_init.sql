-- DiVoice: members, team dictionary and dictation events.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);

-- Dictionary: team entries (owner_id NULL) or personal ones.
-- aliases is a JSON array of the wrong forms to replace with `term`.
CREATE TABLE dictionary_entries (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('team', 'personal')),
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  note        TEXT,
  source      TEXT NOT NULL CHECK (source IN ('seed', 'manual', 'learned')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((scope = 'team' AND owner_id IS NULL) OR (scope = 'personal' AND owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX dict_team_term ON dictionary_entries (lower(term)) WHERE scope = 'team';
CREATE UNIQUE INDEX dict_personal_term ON dictionary_entries (owner_id, lower(term)) WHERE scope = 'personal';

-- One row per dictation or Scribe request. Never the text: only times and outcomes.
CREATE TABLE dictation_events (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         INTEGER NOT NULL,
  mode               TEXT,
  category           TEXT,
  audio_ms           INTEGER,
  words              INTEGER,
  transcription_path TEXT,
  cleanup_path       TEXT,
  server_timings     TEXT,
  client_timings     TEXT,
  total_ms           INTEGER,
  error              TEXT
);
CREATE INDEX events_user_time ON dictation_events (user_id, created_at);
CREATE INDEX events_time ON dictation_events (created_at);
