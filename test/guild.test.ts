import { describe, it, expect } from "vitest";

import { isWrongGuild } from "../src/index";

describe("isWrongGuild — home-server scope guard", () => {
  it("allows a matching guild_id when GUILD_ID is set", () => {
    expect(isWrongGuild({ GUILD_ID: "123" }, { guild_id: "123" })).toBe(false);
  });

  it("rejects a different guild_id when GUILD_ID is set", () => {
    expect(isWrongGuild({ GUILD_ID: "123" }, { guild_id: "999" })).toBe(true);
  });

  it("rejects an ABSENT guild_id when GUILD_ID is set (DM / user-install context)", () => {
    expect(isWrongGuild({ GUILD_ID: "123" }, { guild_id: undefined })).toBe(true);
    expect(isWrongGuild({ GUILD_ID: "123" }, {})).toBe(true);
    expect(isWrongGuild({ GUILD_ID: "123" }, { guild_id: null })).toBe(true);
  });

  it("allows anything when GUILD_ID is unset (no home-server pinned)", () => {
    expect(isWrongGuild({ GUILD_ID: "" }, { guild_id: undefined })).toBe(false);
    expect(isWrongGuild({ GUILD_ID: "" }, { guild_id: "anything" })).toBe(false);
  });
});
