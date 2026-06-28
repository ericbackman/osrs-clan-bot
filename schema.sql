-- OSRS clan bot — D1 schema.
-- Apply:  npx wrangler d1 execute osrs_clan --file schema.sql --remote
-- Note: all Discord IDs are TEXT (snowflakes overflow JS safe integers).

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tracked clan members. discord_user_id (set via /iam) links a player to a
-- Discord account so leaderboards can @-mention people.
CREATE TABLE IF NOT EXISTS players (
  rsn             TEXT PRIMARY KEY,  -- canonical (lower-cased) RuneScape name
  display_name    TEXT NOT NULL,     -- spelling to show
  discord_user_id TEXT,              -- optional Discord link
  added_by        TEXT,
  added_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_discord ON players(discord_user_id);

-- Append-only point-in-time captures (sourced from Wise Old Man, Hiscores fallback).
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  rsn           TEXT NOT NULL,
  captured_at   TEXT NOT NULL,       -- UTC ISO-8601, one per capture run
  overall_xp    INTEGER,
  overall_level INTEGER,
  ehp           REAL,                -- efficient hours played (from WOM)
  collog        INTEGER,             -- collection-log unique count (rare-drop signal)
  UNIQUE(rsn, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_snap_rsn  ON snapshots(rsn);
CREATE INDEX IF NOT EXISTS idx_snap_time ON snapshots(captured_at);

CREATE TABLE IF NOT EXISTS skill_xp (
  snapshot_id INTEGER NOT NULL,
  skill       TEXT NOT NULL,
  level       INTEGER,
  xp          INTEGER,
  PRIMARY KEY (snapshot_id, skill)
);
