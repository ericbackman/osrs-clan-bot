// D1 query layer. Prepared statements + .batch(), mirroring picks-worker/store.ts.

import type { PlayerGains, SkillGain } from "./scoring";
import type { WomPlayer } from "./wom";

export interface PlayerRow {
  rsn: string;
  display_name: string;
  discord_user_id: string | null;
}

export interface SnapshotRow {
  snapshot_id: number;
  rsn: string;
  captured_at: string;
  overall_xp: number;
  overall_level: number;
  ehp: number;
  collog: number | null;
}

/** A per-player "gained N of something over a window" row, best-first. */
export interface GainRow {
  rsn: string;
  displayName: string;
  discordUserId: string | null;
  gained: number;
}

/** Sentinel milestone row marking "we've seeded this player" (see schema.sql). */
export const SEEDED = "__seeded__";

/** OSRS names are case-insensitive and treat spaces/underscores alike. */
export function canonicalRsn(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

export class Store {
  constructor(private db: D1Database) {}

  // ── settings ───────────────────────────────────────────────────────────────
  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .bind(key, value)
      .run();
  }

  // ── players ────────────────────────────────────────────────────────────────
  async addPlayer(
    rsn: string,
    displayName: string,
    addedBy: string,
    addedAt: string,
  ): Promise<boolean> {
    const res = await this.db
      .prepare(
        "INSERT OR IGNORE INTO players(rsn, display_name, discord_user_id, added_by, added_at) " +
          "VALUES(?, ?, NULL, ?, ?)",
      )
      .bind(canonicalRsn(rsn), displayName.trim(), addedBy, addedAt)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async removePlayer(rsn: string): Promise<boolean> {
    const res = await this.db
      .prepare("DELETE FROM players WHERE rsn = ?")
      .bind(canonicalRsn(rsn))
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** /iam — upsert the player and attach the caller's Discord id. */
  async linkDiscord(
    rsn: string,
    discordUserId: string,
    displayName: string,
    addedBy: string,
    addedAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO players(rsn, display_name, discord_user_id, added_by, added_at) " +
          "VALUES(?, ?, ?, ?, ?) " +
          "ON CONFLICT(rsn) DO UPDATE SET discord_user_id = excluded.discord_user_id",
      )
      .bind(canonicalRsn(rsn), displayName.trim(), discordUserId, addedBy, addedAt)
      .run();
  }

  async listPlayers(): Promise<PlayerRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT rsn, display_name, discord_user_id FROM players " +
          "ORDER BY display_name COLLATE NOCASE",
      )
      .all<PlayerRow>();
    return results;
  }

  async resolveRsn(
    rsn: string | null,
    discordUserId: string | null,
  ): Promise<PlayerRow | null> {
    if (rsn) {
      return this.db
        .prepare("SELECT rsn, display_name, discord_user_id FROM players WHERE rsn = ?")
        .bind(canonicalRsn(rsn))
        .first<PlayerRow>();
    }
    if (discordUserId) {
      return this.db
        .prepare(
          "SELECT rsn, display_name, discord_user_id FROM players WHERE discord_user_id = ?",
        )
        .bind(discordUserId)
        .first<PlayerRow>();
    }
    return null;
  }

  // ── snapshots ──────────────────────────────────────────────────────────────
  async latestSnapshotFor(rsn: string): Promise<SnapshotRow | null> {
    return this.db
      .prepare(
        "SELECT snapshot_id, rsn, captured_at, overall_xp, overall_level, ehp, collog " +
          "FROM snapshots WHERE rsn = ? ORDER BY captured_at DESC LIMIT 1",
      )
      .bind(rsn)
      .first<SnapshotRow>();
  }

  async insertSnapshot(
    rsn: string,
    capturedAt: string,
    p: WomPlayer,
  ): Promise<void> {
    const res = await this.db
      .prepare(
        "INSERT OR IGNORE INTO snapshots(rsn, captured_at, overall_xp, overall_level, ehp, collog) " +
          "VALUES(?, ?, ?, ?, ?, ?)",
      )
      .bind(rsn, capturedAt, p.overallXp, p.overallLevel, p.ehp, p.collog)
      .run();
    if ((res.meta.changes ?? 0) === 0) return; // duplicate capture; children already stored

    const snapshotId = res.meta.last_row_id as number;
    const skillStmt = this.db.prepare(
      "INSERT OR REPLACE INTO skill_xp(snapshot_id, skill, level, xp) VALUES(?, ?, ?, ?)",
    );
    const bossStmt = this.db.prepare(
      "INSERT OR REPLACE INTO boss_kc(snapshot_id, boss, kills) VALUES(?, ?, ?)",
    );
    const actStmt = this.db.prepare(
      "INSERT OR REPLACE INTO activity_score(snapshot_id, activity, score) VALUES(?, ?, ?)",
    );
    const stmts = [
      ...p.skills.map((s) => skillStmt.bind(snapshotId, s.skill, s.level, s.xp)),
      ...p.bosses.map((b) => bossStmt.bind(snapshotId, b.boss, b.kills)),
      ...p.activities.map((a) => actStmt.bind(snapshotId, a.activity, a.score)),
    ];
    if (stmts.length) await this.db.batch(stmts);
  }

  /**
   * Per-player per-skill gains from `cutoffIso` to now. "End" is each player's
   * latest snapshot; "start" is their latest snapshot at/before the cutoff. We
   * pull every needed skill row in one query and diff in memory (a handful of
   * queries total, not one-per-player). Players without a baseline are skipped.
   */
  async gainsSince(cutoffIso: string): Promise<PlayerGains[]> {
    // SQLite idiom: with MAX(captured_at), the bare snapshot_id is taken from
    // the row holding that max — i.e. the latest snapshot per player.
    const endRows = (
      await this.db
        .prepare(
          "SELECT rsn, snapshot_id AS sid, MAX(captured_at) AS captured_at " +
            "FROM snapshots GROUP BY rsn",
        )
        .all<{ rsn: string; sid: number; captured_at: string }>()
    ).results;
    const startRows = (
      await this.db
        .prepare(
          "SELECT rsn, snapshot_id AS sid, MAX(captured_at) AS captured_at " +
            "FROM snapshots WHERE captured_at <= ? GROUP BY rsn",
        )
        .bind(cutoffIso)
        .all<{ rsn: string; sid: number; captured_at: string }>()
    ).results;

    const endBy = new Map<string, number>(
      endRows.map((r): [string, number] => [r.rsn, r.sid]),
    );
    const startBy = new Map<string, number>(
      startRows.map((r): [string, number] => [r.rsn, r.sid]),
    );

    const ids = new Set<number>();
    for (const sid of endBy.values()) ids.add(sid);
    for (const sid of startBy.values()) ids.add(sid);
    if (ids.size === 0) return [];

    const idList = [...ids];
    const placeholders = idList.map(() => "?").join(",");
    const skillRows = (
      await this.db
        .prepare(
          `SELECT snapshot_id AS sid, skill, level, xp FROM skill_xp WHERE snapshot_id IN (${placeholders})`,
        )
        .bind(...idList)
        .all<{ sid: number; skill: string; level: number; xp: number }>()
    ).results;

    const bySnap = new Map<number, Map<string, { level: number; xp: number }>>();
    for (const r of skillRows) {
      let m = bySnap.get(r.sid);
      if (!m) {
        m = new Map();
        bySnap.set(r.sid, m);
      }
      m.set(r.skill, { level: r.level, xp: r.xp });
    }

    const out: PlayerGains[] = [];
    for (const p of await this.listPlayers()) {
      const endId = endBy.get(p.rsn);
      const startId = startBy.get(p.rsn);
      if (endId === undefined || startId === undefined || endId === startId) continue;

      const endSkills = bySnap.get(endId) ?? new Map();
      const startSkills = bySnap.get(startId) ?? new Map();
      const gains: SkillGain[] = [];
      for (const [skill, after] of endSkills) {
        const before = startSkills.get(skill);
        if (!before) continue;
        gains.push({
          skill,
          beforeXp: before.xp,
          afterXp: after.xp,
          xpGained: Math.max(after.xp - before.xp, 0),
          beforeLevel: before.level,
          afterLevel: after.level,
          levelsGained: Math.max(after.level - before.level, 0),
        });
      }
      out.push({
        rsn: p.rsn,
        displayName: p.display_name,
        discordUserId: p.discord_user_id,
        skillGains: gains,
      });
    }
    return out;
  }

  /** Per-player collection-log (rare-drop) gains since `cutoffIso`, best first. */
  async dropGainsSince(
    cutoffIso: string,
  ): Promise<
    { rsn: string; displayName: string; discordUserId: string | null; dropsGained: number }[]
  > {
    const end = (
      await this.db
        .prepare(
          "SELECT rsn, collog, MAX(captured_at) AS captured_at FROM snapshots " +
            "WHERE collog IS NOT NULL GROUP BY rsn",
        )
        .all<{ rsn: string; collog: number }>()
    ).results;
    const start = (
      await this.db
        .prepare(
          "SELECT rsn, collog, MAX(captured_at) AS captured_at FROM snapshots " +
            "WHERE collog IS NOT NULL AND captured_at <= ? GROUP BY rsn",
        )
        .bind(cutoffIso)
        .all<{ rsn: string; collog: number }>()
    ).results;

    const startBy = new Map<string, number>(
      start.map((r): [string, number] => [r.rsn, r.collog]),
    );
    const players = new Map<string, PlayerRow>(
      (await this.listPlayers()).map((p): [string, PlayerRow] => [p.rsn, p]),
    );

    const out: {
      rsn: string;
      displayName: string;
      discordUserId: string | null;
      dropsGained: number;
    }[] = [];
    for (const e of end) {
      const before = startBy.get(e.rsn);
      const p = players.get(e.rsn);
      if (before === undefined || !p) continue;
      const dropsGained = e.collog - before;
      if (dropsGained <= 0) continue;
      out.push({
        rsn: e.rsn,
        displayName: p.display_name,
        discordUserId: p.discord_user_id,
        dropsGained,
      });
    }
    out.sort((a, b) => b.dropsGained - a.dropsGained);
    return out;
  }

  /** Players whose collection-log count rose between their last two snapshots. */
  async newDropsSincePrevious(): Promise<
    { displayName: string; discordUserId: string | null; gained: number }[]
  > {
    const out: { displayName: string; discordUserId: string | null; gained: number }[] = [];
    for (const p of await this.listPlayers()) {
      const rows = (
        await this.db
          .prepare(
            "SELECT collog FROM snapshots WHERE rsn = ? AND collog IS NOT NULL " +
              "ORDER BY captured_at DESC LIMIT 2",
          )
          .bind(p.rsn)
          .all<{ collog: number }>()
      ).results;
      if (rows.length < 2) continue;
      const gained = rows[0].collog - rows[1].collog;
      if (gained > 0) {
        out.push({ displayName: p.display_name, discordUserId: p.discord_user_id, gained });
      }
    }
    out.sort((a, b) => b.gained - a.gained);
    return out;
  }

  // ── boss / activity gains (same window-diff shape as gains, keyed by metric) ──

  /** Turn per-player end/start values into positive gains, joined to players. */
  private async diffGains(
    end: { rsn: string; val: number }[],
    start: { rsn: string; val: number }[],
  ): Promise<GainRow[]> {
    const startBy = new Map<string, number>(
      start.map((r): [string, number] => [r.rsn, r.val]),
    );
    const players = new Map<string, PlayerRow>(
      (await this.listPlayers()).map((p): [string, PlayerRow] => [p.rsn, p]),
    );
    const out: GainRow[] = [];
    for (const e of end) {
      const before = startBy.get(e.rsn);
      const p = players.get(e.rsn);
      if (before === undefined || !p) continue; // no baseline for this player/metric
      const gained = e.val - before;
      if (gained <= 0) continue;
      out.push({
        rsn: e.rsn,
        displayName: p.display_name,
        discordUserId: p.discord_user_id,
        gained,
      });
    }
    out.sort((a, b) => b.gained - a.gained);
    return out;
  }

  /**
   * Per-player gains for one metric in a keyed child table (boss_kc/activity_score)
   * since `cutoffIso`. "End" = latest value per player; "start" = latest at/before
   * the cutoff. Same MAX(captured_at) idiom as gainsSince. `table`/columns are
   * internal constants (never user input); only `key` is bound.
   */
  private async keyedGainsSince(
    cutoffIso: string,
    table: "boss_kc" | "activity_score",
    keyCol: string,
    valCol: string,
    key: string,
  ): Promise<GainRow[]> {
    const end = (
      await this.db
        .prepare(
          `SELECT s.rsn AS rsn, t.${valCol} AS val, MAX(s.captured_at) AS captured_at ` +
            `FROM snapshots s JOIN ${table} t ON t.snapshot_id = s.snapshot_id ` +
            `WHERE t.${keyCol} = ? AND t.${valCol} IS NOT NULL GROUP BY s.rsn`,
        )
        .bind(key)
        .all<{ rsn: string; val: number }>()
    ).results;
    const start = (
      await this.db
        .prepare(
          `SELECT s.rsn AS rsn, t.${valCol} AS val, MAX(s.captured_at) AS captured_at ` +
            `FROM snapshots s JOIN ${table} t ON t.snapshot_id = s.snapshot_id ` +
            `WHERE t.${keyCol} = ? AND s.captured_at <= ? AND t.${valCol} IS NOT NULL GROUP BY s.rsn`,
        )
        .bind(key, cutoffIso)
        .all<{ rsn: string; val: number }>()
    ).results;
    return this.diffGains(end, start);
  }

  /** KC gained for one boss (WOM metric key) since the cutoff, best-first. */
  bossKcGainsSince(cutoffIso: string, boss: string): Promise<GainRow[]> {
    return this.keyedGainsSince(cutoffIso, "boss_kc", "boss", "kills", boss);
  }

  /** Score gained for one activity (e.g. a clue tier) since the cutoff, best-first. */
  activityGainsSince(cutoffIso: string, activity: string): Promise<GainRow[]> {
    return this.keyedGainsSince(cutoffIso, "activity_score", "activity", "score", activity);
  }

  /**
   * Total boss KC gained across ALL bosses per player since the cutoff. Diffs
   * per (player, boss) and sums the positive deltas — a boss present at end but
   * with no baseline is skipped so it can't over-count.
   */
  async totalBossGainsSince(cutoffIso: string): Promise<GainRow[]> {
    const end = (
      await this.db
        .prepare(
          "SELECT s.rsn AS rsn, t.boss AS boss, t.kills AS kills, MAX(s.captured_at) AS captured_at " +
            "FROM snapshots s JOIN boss_kc t ON t.snapshot_id = s.snapshot_id " +
            "WHERE t.kills IS NOT NULL GROUP BY s.rsn, t.boss",
        )
        .all<{ rsn: string; boss: string; kills: number }>()
    ).results;
    const start = (
      await this.db
        .prepare(
          "SELECT s.rsn AS rsn, t.boss AS boss, t.kills AS kills, MAX(s.captured_at) AS captured_at " +
            "FROM snapshots s JOIN boss_kc t ON t.snapshot_id = s.snapshot_id " +
            "WHERE s.captured_at <= ? AND t.kills IS NOT NULL GROUP BY s.rsn, t.boss",
        )
        .bind(cutoffIso)
        .all<{ rsn: string; boss: string; kills: number }>()
    ).results;

    const startBy = new Map<string, number>();
    for (const r of start) startBy.set(`${r.rsn}|${r.boss}`, r.kills);
    const gainedByRsn = new Map<string, number>();
    for (const r of end) {
      const before = startBy.get(`${r.rsn}|${r.boss}`);
      if (before === undefined) continue; // no baseline for this boss
      const g = r.kills - before;
      if (g > 0) gainedByRsn.set(r.rsn, (gainedByRsn.get(r.rsn) ?? 0) + g);
    }

    const players = new Map<string, PlayerRow>(
      (await this.listPlayers()).map((p): [string, PlayerRow] => [p.rsn, p]),
    );
    const out: GainRow[] = [];
    for (const [rsn, gained] of gainedByRsn) {
      const p = players.get(rsn);
      if (!p) continue;
      out.push({ rsn, displayName: p.display_name, discordUserId: p.discord_user_id, gained });
    }
    out.sort((a, b) => b.gained - a.gained);
    return out;
  }

  /**
   * A player's boss KC from their two most recent snapshots, for per-night
   * milestone crossings (e.g. "hit 300 Zulrah"). Returns null until they have
   * two snapshots. Unlike the window methods above, this is always "last night
   * vs tonight" — so a crossing is naturally announced exactly once.
   */
  async bossKcLastTwo(
    rsn: string,
  ): Promise<{ curr: Map<string, number>; prev: Map<string, number> } | null> {
    const snaps = (
      await this.db
        .prepare(
          "SELECT snapshot_id FROM snapshots WHERE rsn = ? ORDER BY captured_at DESC LIMIT 2",
        )
        .bind(rsn)
        .all<{ snapshot_id: number }>()
    ).results;
    if (snaps.length < 2) return null;
    const currId = snaps[0].snapshot_id;
    const prevId = snaps[1].snapshot_id;
    const rows = (
      await this.db
        .prepare(
          "SELECT snapshot_id AS sid, boss, kills FROM boss_kc " +
            "WHERE snapshot_id IN (?, ?) AND kills IS NOT NULL",
        )
        .bind(currId, prevId)
        .all<{ sid: number; boss: string; kills: number }>()
    ).results;
    const curr = new Map<string, number>();
    const prev = new Map<string, number>();
    for (const r of rows) (r.sid === currId ? curr : prev).set(r.boss, r.kills);
    return { curr, prev };
  }

  // ── milestones (dedup so each WOM achievement is announced at most once) ──────

  /** All milestone names already processed for a player (includes SEEDED sentinel). */
  async getSeenMilestones(rsn: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare("SELECT milestone FROM announced_milestones WHERE rsn = ?")
      .bind(rsn)
      .all<{ milestone: string }>();
    return new Set(results.map((r) => r.milestone));
  }

  /** Record milestone names as processed (INSERT OR IGNORE — re-recording is a no-op). */
  async recordMilestones(rsn: string, names: string[], at: string): Promise<void> {
    if (!names.length) return;
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO announced_milestones(rsn, milestone, announced_at) VALUES(?, ?, ?)",
    );
    await this.db.batch(names.map((n) => stmt.bind(rsn, n, at)));
  }
}
