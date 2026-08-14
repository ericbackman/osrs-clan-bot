import { describe, it, expect } from "vitest";

import {
  parseDinkEvent,
  parseDuration,
  dropScore,
  formatGp,
  formatDuration,
} from "../src/dink";

describe("parseDinkEvent — LOOT", () => {
  const loot = {
    type: "LOOT",
    playerName: "BodyMeat",
    dinkAccountHash: "abc123",
    extra: {
      items: [
        { id: 12924, quantity: 1, priceEach: 1_200_000_000, name: "Twisted bow" },
        { id: 995, quantity: 500, priceEach: 1, name: "Coins" },
      ],
      source: "Chambers of Xeric",
      category: "EVENT",
      killCount: 412,
      rarestProbability: 0.001634,
    },
  };

  it("surfaces the most valuable item and sums the drop value", () => {
    const ev = parseDinkEvent(loot)!;
    expect(ev.type).toBe("LOOT");
    expect(ev.item).toBe("Twisted bow");
    expect(ev.itemId).toBe(12924);
    expect(ev.value).toBe(1_200_000_500); // 1.2b bow + 500 coins
    expect(ev.source).toBe("Chambers of Xeric");
    expect(ev.kc).toBe(412);
    expect(ev.rarity).toBeCloseTo(0.001634);
    expect(ev.accountHash).toBe("abc123");
  });

  it("builds a stable dedup key that survives identical retries", () => {
    // Dink retries failed deliveries with an identical body — the key must match.
    expect(parseDinkEvent(loot)!.dedupKey).toBe(parseDinkEvent(loot)!.dedupKey);
    expect(parseDinkEvent(loot)!.dedupKey).toBe(
      "bodymeat|LOOT|Chambers of Xeric|412|12924|1200000500",
    );
  });
});

describe("parseDinkEvent — KILL_COUNT + PB", () => {
  it("records the PB time only when this kill was a personal best", () => {
    const pb = parseDinkEvent({
      type: "KILL_COUNT",
      playerName: "rolf it",
      extra: { boss: "Zulrah", count: 300, isPersonalBest: true, time: 92.4 },
    })!;
    expect(pb.source).toBe("Zulrah");
    expect(pb.kc).toBe(300);
    expect(pb.pbSeconds).toBeCloseTo(92.4);
    expect(pb.dedupKey).toBe("rolf it|KILL_COUNT|Zulrah|300");

    const notPb = parseDinkEvent({
      type: "KILL_COUNT",
      playerName: "rolf it",
      extra: { boss: "Vorkath", count: 50, isPersonalBest: false, time: 120 },
    })!;
    expect(notPb.pbSeconds).toBeNull();
  });
});

describe("parseDinkEvent — COLLECTION / CLUE / PET", () => {
  it("COLLECTION carries the item, value, source, and log progress", () => {
    const ev = parseDinkEvent({
      type: "COLLECTION",
      playerName: "BodyMeat",
      extra: {
        itemName: "Twisted bow",
        itemId: 12924,
        price: 1_200_000_000,
        completedEntries: 500,
        totalEntries: 1477,
        dropperName: "Chambers of Xeric",
        dropperKillCount: 412,
      },
    })!;
    expect(ev.item).toBe("Twisted bow");
    expect(ev.value).toBe(1_200_000_000);
    expect(ev.source).toBe("Chambers of Xeric");
    expect(ev.detail).toBe("500/1477 collection log");
    expect(ev.dedupKey).toBe("bodymeat|COLLECTION|12924");
  });

  it("CLUE sums reward value and names the best item", () => {
    const ev = parseDinkEvent({
      type: "CLUE",
      playerName: "rolf it",
      extra: {
        clueType: "Master",
        numberCompleted: 120,
        items: [{ id: 123, quantity: 1, priceEach: 5_000_000, name: "3rd age longsword" }],
      },
    })!;
    expect(ev.value).toBe(5_000_000);
    expect(ev.item).toBe("3rd age longsword");
    expect(ev.source).toBe("Master");
    expect(ev.dedupKey).toBe("rolf it|CLUE|Master|120");
  });

  it("PET keys on the pet name when Dink provides it", () => {
    const ev = parseDinkEvent({
      type: "PET",
      playerName: "IrnmnOfPants",
      extra: { petName: "Olmlet" },
    })!;
    expect(ev.item).toBe("Olmlet");
    expect(ev.dedupKey).toBe("irnmnofpants|PET|Olmlet");
  });
});

describe("parseDinkEvent — privacy gate + validation", () => {
  it("drops sensitive/opt-in types by default (privacy)", () => {
    // DEATH / GE / TRADE etc. are not in CAPTURED_TYPES — never stored.
    expect(parseDinkEvent({ type: "DEATH", playerName: "BodyMeat", extra: { valueLost: 1e6 } })).toBeNull();
    expect(parseDinkEvent({ type: "GRAND_EXCHANGE", playerName: "BodyMeat", extra: {} })).toBeNull();
    expect(parseDinkEvent({ type: "TRADE", playerName: "BodyMeat", extra: {} })).toBeNull();
  });

  it("captures allowed types we don't specially parse (history accrues)", () => {
    const ev = parseDinkEvent({
      type: "QUEST",
      playerName: "BodyMeat",
      extra: { questName: "Dragon Slayer II" },
    })!;
    expect(ev).not.toBeNull();
    expect(ev.type).toBe("QUEST");
    expect(ev.dedupKey.startsWith("bodymeat|QUEST|")).toBe(true);
  });

  it("uppercases the type and rejects payloads with no player or no type", () => {
    expect(parseDinkEvent({ type: "loot", playerName: "x", extra: { items: [] } })!.type).toBe(
      "LOOT",
    );
    expect(parseDinkEvent(null)).toBeNull();
    expect(parseDinkEvent({ type: "LOOT" })).toBeNull(); // no player
    expect(parseDinkEvent({ playerName: "x" })).toBeNull(); // no type
  });
});

describe("parseDuration", () => {
  it("accepts seconds as a number or an 'm:ss.dd' string", () => {
    expect(parseDuration(92.4)).toBeCloseTo(92.4);
    expect(parseDuration("1:32.40")).toBeCloseTo(92.4);
    expect(parseDuration("9.4")).toBeCloseTo(9.4);
    expect(parseDuration("nonsense")).toBeNull();
    expect(parseDuration(NaN)).toBeNull();
  });
});

describe("dropScore (baseline)", () => {
  it("ranks by raw gp value", () => {
    expect(dropScore(1_000_000, 0.001)).toBe(1_000_000);
    expect(dropScore(500, null)).toBe(500);
  });
});

describe("formatGp / formatDuration", () => {
  it("formats gp compactly", () => {
    expect(formatGp(1_200_000_500)).toBe("1.2B");
    expect(formatGp(1_234_567)).toBe("1.23M");
    expect(formatGp(5_000_000)).toBe("5M");
    expect(formatGp(1500)).toBe("1.5K");
    expect(formatGp(999)).toBe("999");
  });

  it("formats PB times as m:ss.dd", () => {
    expect(formatDuration(92.4)).toBe("1:32.40");
    expect(formatDuration(9.4)).toBe("0:09.40");
  });
});
