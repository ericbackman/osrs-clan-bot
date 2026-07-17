// Wise Old Man API client. WOM already snapshots players, computes gains + EHP,
// and survives name changes — so the bot reads from WOM instead of scraping the
// Hiscores itself. Docs: https://docs.wiseoldman.net  API: api.wiseoldman.net/v2

import type { Milestone } from "./milestones";

const WOM_API = "https://api.wiseoldman.net/v2";
// WOM asks for a descriptive User-Agent so they can contact heavy users.
const USER_AGENT = "osrs-clan-bot (Discord clan stats; github.com/ericbackman)";

export interface WomSkill {
  skill: string;
  level: number;
  xp: number;
}

export interface WomBoss {
  boss: string; // WOM metric key, e.g. "zulrah"
  kills: number;
}

export interface WomActivity {
  activity: string; // WOM metric key, e.g. "clue_scrolls_all"
  score: number;
}

export interface WomPlayer {
  displayName: string;
  overallXp: number;
  overallLevel: number;
  ehp: number;
  collog: number | null; // collection-log unique count (null if unranked) — our rare-drop signal
  skills: WomSkill[]; // excludes the derived "overall" row
  bosses: WomBoss[]; // ranked bosses only (kills >= 0)
  activities: WomActivity[]; // ranked activities only (score >= 0), incl. clue tiers
}

export class WomError extends Error {}

function headers(): HeadersInit {
  return { "User-Agent": USER_AGENT, "Content-Type": "application/json" };
}

/**
 * Trigger WOM to re-fetch a player from the Hiscores (keeps gains fresh) and
 * return the updated details. Raises WomError on any non-2xx so the caller can
 * skip one bad name without aborting a whole cron run.
 */
export async function updatePlayer(username: string): Promise<WomPlayer> {
  const resp = await fetch(
    `${WOM_API}/players/${encodeURIComponent(username)}`,
    { method: "POST", headers: headers() },
  );
  if (!resp.ok) throw new WomError(`update ${username}: HTTP ${resp.status}`);
  return parsePlayer(await resp.json());
}

/** Read current details without forcing an update. 404 -> WomError. */
export async function getPlayer(username: string): Promise<WomPlayer> {
  const resp = await fetch(
    `${WOM_API}/players/${encodeURIComponent(username)}`,
    { headers: headers() },
  );
  if (!resp.ok) throw new WomError(`get ${username}: HTTP ${resp.status}`);
  return parsePlayer(await resp.json());
}

/**
 * Normalize a WOM PlayerDetails payload. Pure (no IO) so it's unit-testable
 * against a fixture. WOM's latestSnapshot.data.skills is keyed by lowercase
 * skill name, each {experience, level, rank, ehp}; top-level `exp`/`ehp` are the
 * account totals.
 */
export function parsePlayer(d: any): WomPlayer {
  const data = d?.latestSnapshot?.data ?? {};
  const skillsObj: Record<string, any> = data.skills ?? {};
  const skills: WomSkill[] = [];
  for (const name of Object.keys(skillsObj)) {
    if (name === "overall") continue;
    const row = skillsObj[name] ?? {};
    skills.push({
      skill: name,
      level: Number(row.level ?? 1),
      xp: Math.max(Number(row.experience ?? 0), 0),
    });
  }
  // Bosses: keep only ranked entries (WOM returns kills -1 when unranked), so a
  // never-fought boss never pollutes a KC diff.
  const bossesObj: Record<string, any> = data.bosses ?? {};
  const bosses: WomBoss[] = [];
  for (const name of Object.keys(bossesObj)) {
    const kills = Number(bossesObj[name]?.kills ?? -1);
    if (kills >= 0) bosses.push({ boss: name, kills });
  }
  // Activities: same -1-means-unranked rule. Includes clue-scroll tiers.
  const activitiesObj: Record<string, any> = data.activities ?? {};
  const activities: WomActivity[] = [];
  for (const name of Object.keys(activitiesObj)) {
    const score = Number(activitiesObj[name]?.score ?? -1);
    if (score >= 0) activities.push({ activity: name, score });
  }

  const overall = skillsObj.overall ?? {};
  // Collection-log unique count — the rare-drop signal. WOM returns -1 when the
  // player isn't ranked for it; treat that as unknown (null) so we never diff it.
  const clScore = data.activities?.collections_logged?.score;
  const collog = typeof clScore === "number" && clScore >= 0 ? clScore : null;
  return {
    displayName: String(d?.displayName ?? d?.username ?? "unknown"),
    overallXp: Math.max(Number(d?.exp ?? overall.experience ?? 0), 0),
    overallLevel: Number(overall.level ?? 0),
    ehp: Number(d?.ehp ?? 0),
    collog,
    skills,
    bosses,
    activities,
  };
}

/**
 * Fetch a player's computed achievements (milestones) from WOM. This is a
 * separate GET from updatePlayer — the daily cron calls it once per player after
 * the snapshot. Raises WomError on non-2xx so one bad name skips without aborting
 * the run. Docs: GET /players/:username/achievements.
 */
export async function getAchievements(username: string): Promise<Milestone[]> {
  const resp = await fetch(
    `${WOM_API}/players/${encodeURIComponent(username)}/achievements`,
    { headers: headers() },
  );
  if (!resp.ok) throw new WomError(`achievements ${username}: HTTP ${resp.status}`);
  return parseAchievements(await resp.json());
}

/** Normalize the WOM achievements array. Pure (no IO) so it's unit-testable. */
export function parseAchievements(d: any): Milestone[] {
  if (!Array.isArray(d)) return [];
  return d
    .map((a) => ({
      name: String(a?.name ?? ""),
      metric: String(a?.metric ?? ""),
      threshold: Number(a?.threshold ?? 0),
      createdAt: String(a?.createdAt ?? ""),
    }))
    .filter((m) => m.name.length > 0);
}
