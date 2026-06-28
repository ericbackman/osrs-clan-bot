import { describe, it, expect } from "vitest";

import { rankGains, scorePlayer, type PlayerGains } from "../src/scoring";
import { parsePlayer } from "../src/wom";

function gains(skills: Record<string, number>): PlayerGains["skillGains"] {
  return Object.entries(skills).map(([skill, xp]) => ({
    skill,
    xpGained: xp,
    levelsGained: 0,
    beforeXp: 0,
    afterXp: xp,
    beforeLevel: 1,
    afterLevel: 1,
  }));
}

describe("scorePlayer (baseline)", () => {
  it("sums raw XP gained", () => {
    expect(scorePlayer(gains({ slayer: 1000, mining: 500 }))).toBe(1500);
  });
});

describe("rankGains", () => {
  it("ranks a strictly-dominant player first (monotonicity)", () => {
    const ranked = rankGains([
      { rsn: "grinder", displayName: "Grinder", discordUserId: null, skillGains: gains({ slayer: 2_000_000, mining: 500_000 }) },
      { rsn: "casual", displayName: "Casual", discordUserId: null, skillGains: gains({ slayer: 100_000, mining: 50_000 }) },
    ]);
    expect(ranked.find((r) => r.rank === 1)?.rsn).toBe("grinder");
  });

  it("assigns contiguous places", () => {
    const ranked = rankGains([
      { rsn: "a", displayName: "A", discordUserId: null, skillGains: gains({ mining: 10 }) },
      { rsn: "b", displayName: "B", discordUserId: null, skillGains: gains({ mining: 20 }) },
      { rsn: "c", displayName: "C", discordUserId: null, skillGains: gains({ mining: 30 }) },
    ]);
    expect(ranked.map((r) => r.rank).sort()).toEqual([1, 2, 3]);
  });
});

describe("parsePlayer (WOM shape)", () => {
  const fixture = {
    displayName: "Lynx Titan",
    username: "lynx titan",
    exp: 4_600_000_000,
    ehp: 12164.17,
    latestSnapshot: {
      data: {
        skills: {
          overall: { metric: "overall", experience: 4_600_000_000, level: 2278, ehp: 12164.17 },
          attack: { metric: "attack", experience: 200_000_000, level: 99, ehp: 0 },
          mining: { metric: "mining", experience: 50_000_000, level: 99, ehp: 100 },
        },
        activities: {
          collections_logged: { metric: "collections_logged", score: 850, rank: 5 },
        },
      },
    },
  };

  it("extracts totals and per-skill rows, excluding overall", () => {
    const p = parsePlayer(fixture);
    expect(p.overallXp).toBe(4_600_000_000);
    expect(p.overallLevel).toBe(2278);
    expect(p.ehp).toBeCloseTo(12164.17);
    expect(p.skills.find((s) => s.skill === "overall")).toBeUndefined();
    expect(p.skills.find((s) => s.skill === "attack")?.xp).toBe(200_000_000);
    expect(p.skills.length).toBe(2);
    expect(p.collog).toBe(850);
  });

  it("treats an unranked collection log (-1) as null", () => {
    const p = parsePlayer({
      displayName: "Noob",
      latestSnapshot: {
        data: {
          skills: { overall: { level: 32, experience: 1000 } },
          activities: { collections_logged: { score: -1, rank: -1 } },
        },
      },
    });
    expect(p.collog).toBeNull();
  });
});
