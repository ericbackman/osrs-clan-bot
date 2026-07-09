import { describe, it, expect } from "vitest";

import { parseSeedRoster } from "../src/store";

describe("parseSeedRoster", () => {
  it("returns [] for empty / missing input", () => {
    expect(parseSeedRoster("")).toEqual([]);
    expect(parseSeedRoster(undefined)).toEqual([]);
    expect(parseSeedRoster(null)).toEqual([]);
  });

  it("parses comma-separated names, canonicalizing the RSN but keeping the spelling", () => {
    expect(parseSeedRoster("Lynx Titan, B0aty")).toEqual([
      { rsn: "lynx titan", displayName: "Lynx Titan", discordUserId: null },
      { rsn: "b0aty", displayName: "B0aty", discordUserId: null },
    ]);
  });

  it("reads an optional Discord id after = or :", () => {
    expect(parseSeedRoster("Zezima=987654321, Woox : 42")).toEqual([
      { rsn: "zezima", displayName: "Zezima", discordUserId: "987654321" },
      { rsn: "woox", displayName: "Woox", discordUserId: "42" },
    ]);
  });

  it("skips blank entries and tolerates newlines and stray whitespace", () => {
    expect(parseSeedRoster("  A ,, \n  B \n")).toEqual([
      { rsn: "a", displayName: "A", discordUserId: null },
      { rsn: "b", displayName: "B", discordUserId: null },
    ]);
  });

  it("collapses duplicates by canonical RSN, first spelling wins", () => {
    expect(parseSeedRoster("Lynx_Titan, lynx titan=999, LYNX  TITAN")).toEqual([
      { rsn: "lynx titan", displayName: "Lynx_Titan", discordUserId: null },
    ]);
  });
});
