-- Lyricson D1 schema (SQLite).
-- The Worker also bootstraps these objects on first use, so applying this
-- migration manually is optional but recommended for a hosted database.

-- Short-lived sessions behind the inline buttons.
--   mode = 'search' -> payload {"candidates":[...]}     (result list, paged)
--   mode = 'track'  -> payload {"track":{...},"searchSid":"..."}
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  chat_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'search',
  query       TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL,
  message_id  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);

-- Cache for LRCLIB payloads. Key prefixes: "s:" search results, "g:" a single track.
CREATE TABLE IF NOT EXISTS lyric_cache (
  key         TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Cache for finished translations, so a repeated tap is instant and free.
CREATE TABLE IF NOT EXISTS translation_cache (
  key         TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Per-user settings.
CREATE TABLE IF NOT EXISTS prefs (
  user_id     INTEGER PRIMARY KEY,
  target_lang TEXT NOT NULL DEFAULT 'fa',
  updated_at  INTEGER NOT NULL
);

-- Per-user daily counters, used to keep AI spending bounded.
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Runtime settings changed from the in-bot admin panel. They override env vars.
--   ai_provider | ai_api_key | ai_base_url | ai_model
--   default_target_lang | daily_limit | public_url
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- "The admin is in the middle of setting X" so the next text message is the value.
CREATE TABLE IF NOT EXISTS admin_state (
  user_id     INTEGER PRIMARY KEY,
  action      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Public pages behind the "music card" links (/l/<id> lyrics, /t/<id> lyrics + translation).
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  track       TEXT NOT NULL,
  translation TEXT,
  language    TEXT,
  created_at  INTEGER NOT NULL
);
