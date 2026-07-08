import { describe, it, expect } from "vitest";

import { shouldAnnounceMilestone, milestoneEmoji, type Milestone } from "../src/milestones";
import { parseAchievements, parsePlayer } from "../src/wom";

function milestone(name: string, metric = "overall", threshold = 0): Milestone {
  return { name, metric, threshold, createdAt: "2026-07-08T00:00:00.000Z" };
}

describe("shouldAnnounceMilestone — default (all) mode", () => {
  it("announces skill 99s, maxes, 100m/200m, and boss KC", () => {
    expect(shouldAnnounceMilestone(milestone("99 Slayer", "slayer"))).toBe(true);
    expect(shouldAnnounceMilestone(milestone("Maxed Overall", "overall"))).toBe(true);
    expect(shouldAnnounceMilestone(milestone("100m Mining", "mining"))).toBe(true);
    expect(shouldAnnounceMilestone(milestone("200m Magic", "magic"))).toBe(true);
    expect(shouldAnnounceMilestone(milestone("500 Zulrah kills", "zulrah", 500))).toBe(true);
  });

  it("skips collection-log milestones (covered by /drops)", () => {
    expect(
      shouldAnnounceMilestone(milestone("500 Collections Logged", "collections_logged", 500)),
    ).toBe(false);
  });

  it("skips 'Base N Stats' milestones", () => {
    expect(shouldAnnounceMilestone(milestone("Base 90 Stats", "overall"))).toBe(false);
    expect(shouldAnnounceMilestone(milestone("Base 70 Stats (Pre-Sailing)", "overall"))).toBe(false);
  });
});

describe("shouldAnnounceMilestone — admin modes (set live via /config)", () => {
  it("'off' announces nothing", () => {
    expect(shouldAnnounceMilestone(milestone("99 Slayer", "slayer"), "off")).toBe(false);
    expect(shouldAnnounceMilestone(milestone("Maxed Overall", "overall"), "off")).toBe(false);
  });

  it("'big' keeps headline milestones but drops boss-KC spam", () => {
    expect(shouldAnnounceMilestone(milestone("99 Slayer", "slayer"), "big")).toBe(true);
    expect(shouldAnnounceMilestone(milestone("Maxed Overall", "overall"), "big")).toBe(true);
    expect(shouldAnnounceMilestone(milestone("100m Mining", "mining"), "big")).toBe(true);
    expect(shouldAnnounceMilestone(milestone("500 Zulrah kills", "zulrah", 500), "big")).toBe(false);
    // still skips the always-off categories
    expect(shouldAnnounceMilestone(milestone("Base 90 Stats", "overall"), "big")).toBe(false);
  });
});

describe("milestoneEmoji", () => {
  it("picks a flavour emoji per milestone kind", () => {
    expect(milestoneEmoji(milestone("Maxed Overall"))).toBe("👑");
    expect(milestoneEmoji(milestone("500 Zulrah kills", "zulrah"))).toBe("☠️");
    expect(milestoneEmoji(milestone("99 Attack", "attack"))).toBe("🎉");
    expect(milestoneEmoji(milestone("200m Mining", "mining"))).toBe("💎");
    expect(milestoneEmoji(milestone("100m Magic", "magic"))).toBe("💯");
  });
});

describe("parseAchievements (WOM shape)", () => {
  it("maps the achievements array and drops empties", () => {
    const out = parseAchievements([
      { name: "99 Slayer", metric: "slayer", threshold: 13034431, createdAt: "2026-01-01T00:00:00Z" },
      { name: "", metric: "overall", threshold: 0, createdAt: "" },
      { metric: "zulrah", threshold: 500 }, // no name -> dropped
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("99 Slayer");
    expect(out[0].threshold).toBe(13034431);
  });

  it("returns [] for a non-array payload", () => {
    expect(parseAchievements({ error: "not found" })).toEqual([]);
    expect(parseAchievements(null)).toEqual([]);
  });
});

describe("parsePlayer bosses + activities", () => {
  const fixture = {
    displayName: "Grinder",
    exp: 100_000_000,
    latestSnapshot: {
      data: {
        skills: { overall: { level: 1500, experience: 100_000_000 } },
        bosses: {
          zulrah: { metric: "zulrah", kills: 1234, rank: 10, ehb: 50 },
          abyssal_sire: { metric: "abyssal_sire", kills: -1, rank: -1, ehb: 0 }, // unranked -> dropped
        },
        activities: {
          clue_scrolls_all: { metric: "clue_scrolls_all", score: 300, rank: 5 },
          last_man_standing: { metric: "last_man_standing", score: -1, rank: -1 }, // unranked -> dropped
        },
      },
    },
  };

  it("keeps only ranked bosses and activities", () => {
    const p = parsePlayer(fixture);
    expect(p.bosses).toHaveLength(1);
    expect(p.bosses[0]).toEqual({ boss: "zulrah", kills: 1234 });
    expect(p.activities).toHaveLength(1);
    expect(p.activities[0]).toEqual({ activity: "clue_scrolls_all", score: 300 });
  });

  it("defaults to empty arrays when WOM omits the categories", () => {
    const p = parsePlayer({ displayName: "Newbie", latestSnapshot: { data: { skills: {} } } });
    expect(p.bosses).toEqual([]);
    expect(p.activities).toEqual([]);
  });
});
