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

-- Real-time events pushed by the RuneLite **Dink** plugin (client -> POST /dink),
-- normalized to the handful of fields our boards use (see src/dink.ts). This is a
-- SEPARATE, ADDITIVE, opt-in data source layered on top of the WOM nightly poll —
-- WOM stays the universal baseline for everyone; Dink adds item-level, real-time
-- richness for whoever points a webhook at us. Unlike WOM's aggregate counters,
-- Dink knows *which* item dropped, its value, the source, and boss PB times
-- (which the Hiscores don't expose at all). Append-only; `dedup_key` is a STABLE
-- natural key (never the receive time) so Dink's identical retries are idempotent
-- via INSERT OR IGNORE — same pattern as snapshots/announced_milestones.
CREATE TABLE IF NOT EXISTS dink_events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  rsn          TEXT NOT NULL,     -- canonical RSN, mapped from Dink's playerName
  type         TEXT NOT NULL,     -- Dink type: LOOT, KILL_COUNT, PET, COLLECTION, CLUE, LEVEL, ...
  occurred_at  TEXT NOT NULL,     -- UTC ISO — when we RECEIVED it (Dink sends no reliable event ts)
  source       TEXT,              -- what produced it (boss/npc/activity/clue tier)
  item         TEXT,              -- headline item (loot: most valuable; pet: pet name; coll: item)
  item_id      INTEGER,
  quantity     INTEGER,
  value        INTEGER,           -- gp value for the event (loot: total; coll/clue: reward value)
  rarity       REAL,              -- drop probability if Dink provided it (for a future "luckiest")
  kc           INTEGER,           -- kill count at the event
  pb_seconds   REAL,              -- personal-best time in seconds, only when this kill was a PB
  detail       TEXT,              -- freeform: "99 Slayer", clue tier, collection-log progress, etc.
  account_hash TEXT,              -- Dink's persistent account hash (rename-proof id, for future use)
  dedup_key    TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_dink_rsn  ON dink_events(rsn);
CREATE INDEX IF NOT EXISTS idx_dink_type ON dink_events(type);
CREATE INDEX IF NOT EXISTS idx_dink_time ON dink_events(occurred_at);
