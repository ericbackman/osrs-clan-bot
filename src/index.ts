// Worker entry points: fetch() handles Discord interactions, scheduled() runs the
// daily WOM snapshot + optional auto-post. Routing only — logic lives in the
// store/wom/scoring modules. Mirrors picks-worker/src/index.ts.

import {
  Env,
  InteractionType,
  ResponseType,
  EPHEMERAL,
  EMBED_COLOR,
  verifyDiscordRequest,
  editOriginalResponse,
  postToChannel,
  option,
  subcommand,
  subOption,
  userId,
} from "./discord";
import { Store, canonicalRsn, SEEDED, type GainRow, type PlayerRow } from "./store";
import * as wom from "./wom";
import { rankGains, type RankedPlayer } from "./scoring";
import { shouldAnnounceMilestone, milestoneEmoji, type MilestoneMode } from "./milestones";

const DAY_MS = 86_400_000;

/** Clue-scroll tiers -> WOM activity metric keys (for /clues). */
const CLUE_TIERS: Record<string, string> = {
  all: "clue_scrolls_all",
  beginner: "clue_scrolls_beginner",
  easy: "clue_scrolls_easy",
  medium: "clue_scrolls_medium",
  hard: "clue_scrolls_hard",
  elite: "clue_scrolls_elite",
  master: "clue_scrolls_master",
};

/** window choice -> number of days. */
function windowDays(window: string | undefined): number {
  return window === "day" ? 1 : window === "month" ? 30 : 7;
}

/** Best-effort map a typed boss name to a WOM metric key ("K'ril" -> "kril_tsutsaroth" is on the user; we just normalize spacing/case). */
function normalizeBoss(name: string): string {
  return name.trim().toLowerCase().replace(/['`]/g, "").replace(/[\s-]+/g, "_");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function reply(content: string, ephemeral = true): Response {
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: { content, flags: ephemeral ? EPHEMERAL : 0 },
  });
}

function replyEmbed(embed: object, ephemeral = false): Response {
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: { embeds: [embed], flags: ephemeral ? EPHEMERAL : 0 },
  });
}

function deferred(ephemeral = false): Response {
  return json({
    type: ResponseType.DEFERRED_CHANNEL_MESSAGE,
    data: { flags: ephemeral ? EPHEMERAL : 0 },
  });
}

function medal(rank: number): string {
  return rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
}

function nameTag(r: RankedPlayer): string {
  return r.discordUserId ? `<@${r.discordUserId}>` : `**${r.displayName}**`;
}

function boardLines(ranked: RankedPlayer[], limit = 15): string {
  return ranked
    .filter((r) => r.xpGained > 0)
    .slice(0, limit)
    .map((r) => `${medal(r.rank)} ${nameTag(r)} — ${r.xpGained.toLocaleString()} xp`)
    .join("\n");
}

/** Render a simple "gained N <unit>" board from GainRow[] (already sorted). */
function gainBoardLines(rows: GainRow[], unit: string, limit = 15): string {
  return rows
    .slice(0, limit)
    .map((r, i) => {
      const who = r.discordUserId ? `<@${r.discordUserId}>` : `**${r.displayName}**`;
      return `${medal(i + 1)} ${who} — ${r.gained.toLocaleString()} ${unit}`;
    })
    .join("\n");
}

function helpEmbed(): object {
  return {
    title: "👋 OSRS Clan Companion",
    color: EMBED_COLOR,
    description:
      "I track the clan's Old School RuneScape stats and gains (via Wise Old Man) " +
      "so we can race XP and flex grinds — nobody has to log into anything.",
    fields: [
      {
        name: "Get on the board",
        value:
          "`/track add <rsn>` — track a player\n" +
          "`/iam <rsn>` — link your Discord to your RSN so you get @-mentioned",
      },
      {
        name: "See stats",
        value:
          "`/leaderboard [day|week|month] [skill]` — the XP gains race\n" +
          "`/drops [day|week|month]` — rare-drop (collection log) race\n" +
          "`/boss [name] [day|week|month]` — PvM KC race (all bosses, or one)\n" +
          "`/clues [tier] [day|week|month]` — clue-scroll casket race\n" +
          "`/stats <rsn | @member>` — a player's current levels & XP",
      },
      {
        name: "Admin controls (Eric & Stevie) — all take effect instantly, no redeploy",
        value:
          "`/config show` — see the bot's current settings\n" +
          "`/config channel #channel` — where I auto-post\n" +
          "`/config schedule daily|weekly|off` — how often I post the gains board\n" +
          "`/config milestones all|big|off` — how chatty milestone shout-outs are",
      },
    ],
    footer: { text: "Built by Eric — admins can tune me live with /config (no redeploy)." },
  };
}

function handleHelp(): Response {
  return replyEmbed(helpEmbed(), true); // ephemeral — only the asker sees it
}

/**
 * Introduce the bot the first time it's used in the server. Interactions-only
 * bots can't see the raw "joined a guild" gateway event, so we greet on first
 * command instead — posted publicly in that channel, then flagged in D1 so it
 * only happens once.
 */
async function maybeGreet(env: Env, store: Store, interaction: any): Promise<void> {
  if (await store.getSetting("greeted")) return;
  const channelId = interaction.channel_id;
  if (!channelId) return;
  await store.setSetting("greeted", "1"); // set first so racing commands don't double-post
  await postToChannel(env, channelId, {
    content: "👋 Thanks for adding me!",
    embeds: [helpEmbed()],
  });
}

// ── command handlers ──────────────────────────────────────────────────────────

async function handleTrack(
  env: Env,
  store: Store,
  interaction: any,
  ctx: ExecutionContext,
): Promise<Response> {
  const sub = subcommand(interaction);

  if (sub === "list") {
    const players = await store.listPlayers();
    if (!players.length) return reply("No one tracked yet. Try `/track add <rsn>`.");
    const lines = players.map(
      (p) =>
        `• **${p.display_name}**${p.discord_user_id ? ` — <@${p.discord_user_id}>` : ""}`,
    );
    return reply(`Tracking ${players.length}:\n${lines.join("\n")}`);
  }

  if (sub === "remove") {
    const rsn = String(subOption(interaction, "rsn") ?? "");
    const ok = await store.removePlayer(rsn);
    return reply(ok ? `Removed **${rsn}**.` : `**${rsn}** wasn't tracked.`);
  }

  if (sub === "add") {
    const rsn = String(subOption(interaction, "rsn") ?? "").trim();
    const member = subOption(interaction, "member") as string | undefined;
    const addedAt = new Date().toISOString();
    const by = userId(interaction);
    // Defer: we hit WOM to grab an immediate first snapshot so /stats works now.
    ctx.waitUntil(
      (async () => {
        let text: string;
        try {
          const added = await store.addPlayer(rsn, rsn, by, addedAt);
          if (member) await store.linkDiscord(rsn, member, rsn, by, addedAt);
          const p = await wom.updatePlayer(rsn);
          await store.insertSnapshot(canonicalRsn(rsn), addedAt, p);
          text =
            `${added ? "Now tracking" : "Updated"} **${p.displayName}** — ` +
            `${p.overallLevel} total, ${p.overallXp.toLocaleString()} xp` +
            (member ? `, linked to <@${member}>` : "") +
            ".";
        } catch (e) {
          text =
            `Added **${rsn}** to the roster, but couldn't fetch stats yet ` +
            `(${(e as Error).message}). The daily pull will retry.`;
        }
        await editOriginalResponse(env, interaction.token, { content: text });
      })(),
    );
    return deferred();
  }

  return reply("Use `/track add`, `/track remove`, or `/track list`.");
}

async function handleIam(store: Store, interaction: any): Promise<Response> {
  const rsn = String(option(interaction, "rsn") ?? "").trim();
  const uid = userId(interaction);
  const now = new Date().toISOString();
  await store.linkDiscord(rsn, uid, rsn, uid, now);
  return reply(`Linked you to **${rsn}** — you'll be @-mentioned on the leaderboard.`);
}

async function handleStats(store: Store, interaction: any): Promise<Response> {
  const rsn = (option(interaction, "rsn") as string | undefined) ?? null;
  const member = (option(interaction, "member") as string | undefined) ?? null;
  const row = await store.resolveRsn(rsn, member);
  if (!row) return reply("Couldn't find that player. Add them with `/track add`.");

  const snap = await store.latestSnapshotFor(row.rsn);
  if (!snap) {
    return reply(`No snapshot for **${row.display_name}** yet — the daily pull will grab it.`);
  }
  return replyEmbed(
    {
      title: row.display_name,
      color: EMBED_COLOR,
      description:
        `Total level **${snap.overall_level}**\n` +
        `Overall XP **${snap.overall_xp.toLocaleString()}**\n` +
        `EHP **${snap.ehp.toFixed(1)}**` +
        (snap.collog != null ? `\nCollection log **${snap.collog}**` : ""),
      footer: { text: `as of ${snap.captured_at.slice(0, 10)}` },
    },
    true,
  );
}

async function handleLeaderboard(store: Store, interaction: any): Promise<Response> {
  const window = (option(interaction, "window") as string | undefined) ?? "week";
  const days = window === "day" ? 1 : window === "month" ? 30 : 7;
  const skill = (option(interaction, "skill") as string | undefined)?.toLowerCase();
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();

  let players = await store.gainsSince(cutoff);
  if (skill) {
    players = players.map((p) => ({
      ...p,
      skillGains: p.skillGains.filter((g) => g.skill.toLowerCase() === skill),
    }));
  }
  if (!players.length) {
    return reply("Not enough history yet — I need at least two daily snapshots. Check back tomorrow!");
  }

  let ranked: RankedPlayer[];
  try {
    ranked = rankGains(players);
  } catch (e) {
    return reply(`Leaderboard scoring isn't set up yet: ${(e as Error).message}`);
  }

  const lines = boardLines(ranked);
  return replyEmbed({
    title: `🏆 Gains — last ${days}d${skill ? ` · ${skill}` : ""}`,
    color: EMBED_COLOR,
    description: lines || "No gains in this window.",
  });
}

async function handleDrops(store: Store, interaction: any): Promise<Response> {
  const window = (option(interaction, "window") as string | undefined) ?? "week";
  const days = window === "day" ? 1 : window === "month" ? 30 : 7;
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();

  const rows = await store.dropGainsSince(cutoff);
  if (!rows.length) {
    return reply(
      "No new collection-log drops in this window yet — needs two snapshots to compare.",
    );
  }
  const lines = rows
    .slice(0, 15)
    .map((r, i) => {
      const who = r.discordUserId ? `<@${r.discordUserId}>` : `**${r.displayName}**`;
      return `${medal(i + 1)} ${who} — ${r.dropsGained} new`;
    })
    .join("\n");
  return replyEmbed({
    title: `💎 Rare drops — last ${days}d`,
    color: EMBED_COLOR,
    description: lines,
  });
}

async function handleBoss(store: Store, interaction: any): Promise<Response> {
  const bossInput = (option(interaction, "boss") as string | undefined)?.trim();
  const days = windowDays(option(interaction, "window") as string | undefined);
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();

  if (!bossInput) {
    // No boss named — the "who's been PvMing" board: total KC gained, all bosses.
    const rows = await store.totalBossGainsSince(cutoff);
    if (!rows.length) {
      return reply("No boss KC gained in this window yet — needs two daily snapshots to compare.");
    }
    return replyEmbed({
      title: `☠️ PvM — last ${days}d (all bosses)`,
      color: EMBED_COLOR,
      description: gainBoardLines(rows, "kills"),
    });
  }

  const metric = normalizeBoss(bossInput);
  const rows = await store.bossKcGainsSince(cutoff, metric);
  if (!rows.length) {
    return reply(
      `No **${bossInput}** KC gained in this window. Check the name (I use Wise Old Man's ` +
        `spelling, e.g. \`commander_zilyana\`, \`the_gauntlet\`), or wait for two snapshots.`,
    );
  }
  return replyEmbed({
    title: `☠️ ${bossInput} — last ${days}d`,
    color: EMBED_COLOR,
    description: gainBoardLines(rows, "kc"),
  });
}

async function handleClues(store: Store, interaction: any): Promise<Response> {
  const tier = ((option(interaction, "tier") as string | undefined) ?? "all").toLowerCase();
  const activity = CLUE_TIERS[tier] ?? CLUE_TIERS.all;
  const days = windowDays(option(interaction, "window") as string | undefined);
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();

  const rows = await store.activityGainsSince(cutoff, activity);
  if (!rows.length) {
    return reply(
      `No ${tier === "all" ? "" : `${tier} `}clue caskets in this window yet — needs two snapshots.`,
    );
  }
  return replyEmbed({
    title: `📜 Clues — last ${days}d${tier === "all" ? "" : ` · ${tier}`}`,
    color: EMBED_COLOR,
    description: gainBoardLines(rows, "caskets"),
  });
}

async function handleConfig(store: Store, interaction: any): Promise<Response> {
  const sub = subcommand(interaction);
  if (sub === "channel") {
    const channelId = String(subOption(interaction, "channel") ?? "");
    await store.setSetting("post_channel_id", channelId);
    return reply(`Auto-posts will go to <#${channelId}>.`);
  }
  if (sub === "schedule") {
    const cadence = String(subOption(interaction, "cadence") ?? "off");
    await store.setSetting("schedule", cadence);
    return reply(`Auto-post schedule set to **${cadence}**.`);
  }
  if (sub === "milestones") {
    const mode = String(subOption(interaction, "mode") ?? "all");
    await store.setSetting("milestones_mode", mode);
    const note =
      mode === "off"
        ? " — I'll stop posting milestones (still tracked, so turning it back on won't spam)."
        : mode === "big"
          ? " — headline milestones only (99s, maxes, 100m/200m, combat); boss KC lives on `/boss`."
          : " — everything except collection-log (that's `/drops`).";
    return reply(`Milestone announcements set to **${mode}**${note}`);
  }
  if (sub === "show") {
    const channel = await store.getSetting("post_channel_id");
    const schedule = (await store.getSetting("schedule")) ?? "off";
    const milestones = (await store.getSetting("milestones_mode")) ?? "all";
    return reply(
      "**Current settings**\n" +
        `• Auto-post channel: ${channel ? `<#${channel}>` : "*not set — use `/config channel`*"}\n` +
        `• Schedule: **${schedule}**\n` +
        `• Milestones: **${milestones}**\n\n` +
        "Change any of these live with `/config` — no redeploy needed.",
    );
  }
  return reply("Use `/config show`, `/config channel`, `/config schedule`, or `/config milestones`.");
}

// ── cron: daily snapshot + optional auto-post ─────────────────────────────────

/**
 * Fetch a player's WOM achievements, seed silently on first sight (so we never
 * dump their whole history of 99s into the channel), else return announcement
 * lines for milestones earned since last night. Records every milestone it
 * processes — announced or filtered out — so each is handled exactly once.
 */
async function collectPlayerMilestones(
  store: Store,
  p: PlayerRow,
  at: string,
  mode: MilestoneMode,
): Promise<string[]> {
  const seen = await store.getSeenMilestones(p.rsn);
  const achievements = await wom.getAchievements(p.display_name);

  if (!seen.has(SEEDED)) {
    await store.recordMilestones(p.rsn, [SEEDED, ...achievements.map((a) => a.name)], at);
    return []; // first sight — announce nothing
  }

  const fresh = achievements.filter((a) => !seen.has(a.name));
  // Record every fresh milestone even when mode='off' so re-enabling never floods.
  if (fresh.length) await store.recordMilestones(p.rsn, fresh.map((a) => a.name), at);

  const tag = p.discord_user_id ? `<@${p.discord_user_id}>` : `**${p.display_name}**`;
  return fresh
    .filter((m) => shouldAnnounceMilestone(m, mode))
    .map((m) => `${milestoneEmoji(m)} ${tag} — ${m.name}!`);
}

async function runDailySnapshot(env: Env): Promise<void> {
  const store = new Store(env.DB);
  const players = await store.listPlayers();
  const capturedAt = new Date().toISOString();
  const milestoneMode = ((await store.getSetting("milestones_mode")) ?? "all") as MilestoneMode;

  const milestoneLines: string[] = [];
  for (const p of players) {
    try {
      const wp = await wom.updatePlayer(p.display_name);
      await store.insertSnapshot(p.rsn, capturedAt, wp);
    } catch (e) {
      console.error(`snapshot failed for ${p.display_name}: ${(e as Error).message}`);
    }
    // Milestones — independent GET; recorded even when we don't/can't post (below),
    // so a later "turn posting on" never floods the channel with old milestones.
    try {
      milestoneLines.push(...(await collectPlayerMilestones(store, p, capturedAt, milestoneMode)));
    } catch (e) {
      console.error(`milestones skipped for ${p.display_name}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // be polite to WOM
  }

  const schedule = await store.getSetting("schedule");
  const channel = await store.getSetting("post_channel_id");
  if (!channel || schedule === "off") return;

  // Milestone celebrations — new 99s, maxes, and KC milestones earned overnight.
  if (milestoneLines.length) {
    try {
      await postToChannel(env, channel, {
        embeds: [
          {
            title: "🎉 Milestones!",
            color: EMBED_COLOR,
            description: milestoneLines.slice(0, 20).join("\n"),
          },
        ],
      });
    } catch (e) {
      console.error(`milestones announce skipped: ${(e as Error).message}`);
    }
  }

  // Rare-drop announcement — any day someone's collection log rose overnight.
  try {
    const drops = await store.newDropsSincePrevious();
    if (drops.length) {
      const lines = drops
        .slice(0, 15)
        .map(
          (d) =>
            `🎉 ${d.discordUserId ? `<@${d.discordUserId}>` : `**${d.displayName}**`} — ` +
            `${d.gained} new rare drop${d.gained > 1 ? "s" : ""}!`,
        )
        .join("\n");
      await postToChannel(env, channel, {
        embeds: [{ title: "💎 New rare drops!", color: EMBED_COLOR, description: lines }],
      });
    }
  } catch (e) {
    console.error(`drops announce skipped: ${(e as Error).message}`);
  }

  // Weekly XP gains board — daily, or only Mondays for "weekly".
  const isMonday = new Date().getUTCDay() === 1;
  if (schedule === "daily" || (schedule === "weekly" && isMonday)) {
    const cutoff = new Date(Date.now() - 7 * DAY_MS).toISOString();
    try {
      const lines = boardLines(rankGains(await store.gainsSince(cutoff)));
      if (lines) {
        await postToChannel(env, channel, {
          embeds: [{ title: "🏆 Weekly gains", color: EMBED_COLOR, description: lines }],
        });
      }
    } catch (e) {
      console.error(`auto-post skipped: ${(e as Error).message}`);
    }
  }
}

// ── entry points ──────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("osrs-clan-bot up");
    }
    if (req.method !== "POST" || url.pathname !== "/interactions") {
      return new Response("not found", { status: 404 });
    }

    const sig = req.headers.get("x-signature-ed25519");
    const ts = req.headers.get("x-signature-timestamp");
    const body = await req.text();
    if (!(await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, sig, ts, body))) {
      return new Response("bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);
    if (interaction.type === InteractionType.PING) {
      return json({ type: ResponseType.PONG });
    }
    if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
      return reply("Unsupported interaction.");
    }
    if (env.GUILD_ID && interaction.guild_id && interaction.guild_id !== env.GUILD_ID) {
      return reply("This bot is configured for a different server.");
    }

    const store = new Store(env.DB);
    // First time the bot is used in the server, introduce itself in that channel.
    ctx.waitUntil(maybeGreet(env, store, interaction).catch(() => {}));
    try {
      switch (interaction.data?.name) {
        case "help":
          return handleHelp();
        case "track":
          return await handleTrack(env, store, interaction, ctx);
        case "iam":
          return await handleIam(store, interaction);
        case "leaderboard":
          return await handleLeaderboard(store, interaction);
        case "drops":
          return await handleDrops(store, interaction);
        case "boss":
          return await handleBoss(store, interaction);
        case "clues":
          return await handleClues(store, interaction);
        case "stats":
          return await handleStats(store, interaction);
        case "config":
          return await handleConfig(store, interaction);
        default:
          return reply("Unknown command.");
      }
    } catch (e) {
      return reply(`⚠️ Something broke: ${(e as Error).message}`);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailySnapshot(env));
  },
};
