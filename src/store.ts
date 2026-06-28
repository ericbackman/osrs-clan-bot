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
    if ((res.meta.changes ?? 0) === 0) return; // duplicate capture; skills already stored

    const snapshotId = res.meta.last_row_id as number;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO skill_xp(snapshot_id, skill, level, xp) VALUES(?, ?, ?, ?)",
    );
    await this.db.batch(
      p.skills.map((s) => stmt.bind(snapshotId, s.skill, s.level, s.xp)),
    );
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
}
