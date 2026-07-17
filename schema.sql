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

-- Per-snapshot boss kill counts (WOM `bosses`, kills >= 0 only — WOM returns -1
-- when unranked). Powers /boss and the PvM board; diffed over a window like
-- skill_xp. Mirrors skill_xp's snapshot_id -> rows shape.
CREATE TABLE IF NOT EXISTS boss_kc (
  snapshot_id INTEGER NOT NULL,
  boss        TEXT NOT NULL,     -- WOM metric key, e.g. "zulrah", "commander_zilyana"
  kills       INTEGER,
  PRIMARY KEY (snapshot_id, boss)
);

-- Per-snapshot activity scores (WOM `activities`, score >= 0 only) — clue-scroll
-- tiers, LMS, Soul Wars, etc. Powers /clues.
CREATE TABLE IF NOT EXISTS activity_score (
  snapshot_id INTEGER NOT NULL,
  activity    TEXT NOT NULL,     -- WOM metric key, e.g. "clue_scrolls_all"
  score       INTEGER,
  PRIMARY KEY (snapshot_id, activity)
);

-- Milestones already handled, so each WOM achievement is announced at most once.
-- Seeded silently the first time we see a player (a '__seeded__' sentinel row
-- plus all current achievements) so we never flood the channel with historical
-- 99s; after that, only achievements NOT in this table are new since last night.
-- Records every milestone PROCESSED (announced or filtered out) — loosening the
-- announce filter later won't retroactively re-announce old ones.
CREATE TABLE IF NOT EXISTS announced_milestones (
  rsn          TEXT NOT NULL,
  milestone    TEXT NOT NULL,   -- WOM achievement name, e.g. "99 Slayer"
  announced_at TEXT NOT NULL,
  PRIMARY KEY (rsn, milestone)
);
