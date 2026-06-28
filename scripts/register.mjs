// Register slash commands to the configured guild. Run: npm run register
// Reads APP id / guild id from wrangler.jsonc (single source) and the bot token
// from .dev.vars or the environment. Guild-scoped = updates appear instantly.

import { readFileSync } from "node:fs";
import process from "node:process";

function loadDevVars() {
  try {
    const txt = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .dev.vars — fall back to process.env */
  }
}

function loadWranglerVars() {
  const txt = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l)) // drop full-line // comments
    .join("\n");
  return JSON.parse(txt).vars ?? {};
}

loadDevVars();
const vars = loadWranglerVars();
const APP = process.env.DISCORD_APPLICATION_ID || vars.DISCORD_APPLICATION_ID;
const GUILD = process.env.GUILD_ID || vars.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

if (!APP || !GUILD || !TOKEN) {
  console.error(
    "Missing config. Need DISCORD_APPLICATION_ID + GUILD_ID in wrangler.jsonc " +
      "and DISCORD_TOKEN in .dev.vars (or the environment).",
  );
  process.exit(1);
}

// Option types: 1 SUB_COMMAND, 3 STRING, 6 USER, 7 CHANNEL.
const commands = [
  { name: "help", description: "What this bot does + how to use it" },
  {
    name: "track",
    description: "Manage the tracked clan roster",
    default_member_permissions: "32", // MANAGE_GUILD
    options: [
      {
        type: 1,
        name: "add",
        description: "Track a RuneScape name",
        options: [
          { type: 3, name: "rsn", description: "RuneScape username", required: true },
          { type: 6, name: "member", description: "Link to a Discord member", required: false },
        ],
      },
      {
        type: 1,
        name: "remove",
        description: "Stop tracking a name",
        options: [{ type: 3, name: "rsn", description: "RuneScape username", required: true }],
      },
      { type: 1, name: "list", description: "Show tracked players" },
    ],
  },
  {
    name: "iam",
    description: "Link your Discord to your RuneScape name",
    options: [{ type: 3, name: "rsn", description: "Your RuneScape username", required: true }],
  },
  {
    name: "leaderboard",
    description: "Gains leaderboard",
    options: [
      {
        type: 3,
        name: "window",
        description: "Time window",
        required: false,
        choices: [
          { name: "day", value: "day" },
          { name: "week", value: "week" },
          { name: "month", value: "month" },
        ],
      },
      { type: 3, name: "skill", description: "Limit to one skill (e.g. slayer)", required: false },
    ],
  },
  {
    name: "drops",
    description: "Rare-drop (collection log) leaderboard",
    options: [
      {
        type: 3,
        name: "window",
        description: "Time window",
        required: false,
        choices: [
          { name: "day", value: "day" },
          { name: "week", value: "week" },
          { name: "month", value: "month" },
        ],
      },
    ],
  },
  {
    name: "stats",
    description: "A player's current stats",
    options: [
      { type: 3, name: "rsn", description: "RuneScape username", required: false },
      { type: 6, name: "member", description: "A Discord member", required: false },
    ],
  },
  {
    name: "config",
    description: "Configure the bot (admins)",
    default_member_permissions: "32",
    options: [
      {
        type: 1,
        name: "channel",
        description: "Set the auto-post channel",
        options: [
          { type: 7, name: "channel", description: "Text channel", required: true, channel_types: [0] },
        ],
      },
      {
        type: 1,
        name: "schedule",
        description: "Set auto-post cadence",
        options: [
          {
            type: 3,
            name: "cadence",
            description: "How often to auto-post",
            required: true,
            choices: [
              { name: "daily", value: "daily" },
              { name: "weekly", value: "weekly" },
              { name: "off", value: "off" },
            ],
          },
        ],
      },
    ],
  },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${APP}/guilds/${GUILD}/commands`,
  {
    method: "PUT",
    headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  },
);

if (!res.ok) {
  console.error("Registration failed:", res.status, await res.text());
  process.exit(1);
}
console.log(`Registered ${commands.length} commands to guild ${GUILD}.`);
