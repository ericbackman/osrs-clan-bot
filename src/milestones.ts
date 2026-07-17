// Milestone announcements — the "🎉 hit 99 Slayer!" signal. Wise Old Man computes
// a curated, dated set of achievements per player (99s, Maxed, 100m/200m XP, boss
// KC milestones, combat); the bot fetches them nightly, diffs against what it has
// already seen, and celebrates the new ones. Domain types + the announce filter
// live here (pure, so they're unit-testable); IO is in wom.ts, dedup in store.ts.

export interface Milestone {
  name: string; // WOM achievement name, e.g. "99 Slayer", "500 Zulrah kills"
  metric: string; // WOM metric key, e.g. "slayer", "zulrah", "overall"
  threshold: number; // numeric threshold WOM assigned (13034431 for a 99, 500 for KC)
  createdAt: string; // ISO date WOM first recorded it
}

/**
 * How chatty milestone announcements are — set live by admins via
 * `/config milestones` (stored in D1 as `milestones_mode`), no redeploy needed.
 *   • "all" — life milestones (99s, Maxed, 100m/200m XP, combat) AND boss-KC
 *             milestones every `boss_kc_interval` kills (see below).
 *   • "big" — life milestones only, no boss-KC.
 *   • "off" — announce nothing (the cron still records life milestones so
 *             re-enabling later never floods the channel with history).
 */
export type MilestoneMode = "all" | "big" | "off";

/**
 * Default kills-per-boss-KC-announcement. WOM's own achievements only fire at
 * 10/50/100/200/500/1000/5000, so a not-yet-maxed clan gets nothing between 200
 * and 500 — we compute our own from the `boss_kc` snapshots instead, at whatever
 * interval admins set via `/config bosskc` (this is just the fallback).
 */
export const DEFAULT_BOSS_KC_INTERVAL = 100;

/**
 * Decide whether a freshly-earned WOM *life* milestone is worth a clan ping.
 * Boss-KC milestones are handled separately (per-interval, from our own KC data),
 * so WOM's "N Boss kills" achievements are always skipped here to avoid dupes and
 * their coarse thresholds. The cron records every milestone it PROCESSES
 * (announced or not), so changing the mode never retroactively floods the channel.
 */
export function shouldAnnounceMilestone(m: Milestone, mode: MilestoneMode = "all"): boolean {
  if (mode === "off") return false;
  const name = m.name.toLowerCase();
  if (m.metric === "collections_logged" || name.includes("collections logged")) {
    return false; // covered by /drops
  }
  if (name.startsWith("base ")) return false; // "Base 90 Stats" — less flex than a 99
  if (name.includes("kills")) return false; // boss KC handled by our per-interval tracker
  return true; // 99s, Maxed, 100m/200m, combat — in both "all" and "big"
}

/**
 * The highest multiple of `interval` newly reached going from `prev` to `curr`
 * kills; null if none was crossed. E.g. (90 -> 140, 100) = 100; (180 -> 320, 100)
 * = 300 (announce the top one, not every century in the jump); (100 -> 150, 100)
 * = null (already had 100). Pure + tested — this is the boss-KC milestone rule.
 */
export function crossedMultiple(prev: number, curr: number, interval: number): number | null {
  if (interval <= 0 || curr <= prev) return null;
  const reached = Math.floor(curr / interval) * interval;
  return reached > prev && reached >= interval ? reached : null;
}

/** Prettify a WOM boss metric key: "commander_zilyana" -> "Commander Zilyana". */
export function prettyBoss(metric: string): string {
  return metric
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Emoji that fits the flavour of a milestone, for the announcement line. */
export function milestoneEmoji(m: Milestone): string {
  const n = m.name.toLowerCase();
  if (n.includes("maxed")) return "👑";
  if (n.includes("kills")) return "☠️";
  if (n.includes("200m")) return "💎";
  if (n.includes("100m")) return "💯";
  if (n.startsWith("99 ")) return "🎉";
  if (n.includes("combat")) return "⚔️";
  return "⭐";
}
