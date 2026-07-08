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
 *   • "all" — everything except collection-log (that's /drops) and "Base N Stats".
 *   • "big" — headline only: 99s, Maxed, 100m/200m XP, combat. No boss-KC spam
 *             (a grinder crosses KC thresholds constantly — that lives on /boss).
 *   • "off" — announce nothing (the cron still records milestones so re-enabling
 *             later never floods the channel with history).
 */
export type MilestoneMode = "all" | "big" | "off";

/**
 * Decide whether a freshly-earned milestone is worth pinging the whole clan for.
 * WOM already curates out the noise (no "level 50 Mining" achievement exists), so
 * this is a VOLUME/taste call, not a correctness one — which is why it's an admin
 * setting (`mode`) rather than hardcoded. The cron records every milestone it
 * PROCESSES (announced or not), so changing the mode never retroactively floods
 * the channel — only milestones earned after the change are affected.
 */
export function shouldAnnounceMilestone(m: Milestone, mode: MilestoneMode = "all"): boolean {
  if (mode === "off") return false;
  const name = m.name.toLowerCase();
  if (m.metric === "collections_logged" || name.includes("collections logged")) {
    return false; // covered by /drops
  }
  if (name.startsWith("base ")) return false; // "Base 90 Stats" — less flex than a 99
  if (mode === "big") return !name.includes("kills"); // headline only; boss KC -> /boss
  return true; // "all"
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
