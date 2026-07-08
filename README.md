# osrs-clan-bot

A Discord bot that tracks an Old School RuneScape friend group's stats and gains,
so the clan can race XP and flex grinds — **without anyone logging into a game or
running anything sketchy.** It reads public stats from the **Wise Old Man** API,
stores them in Cloudflare **D1**, and serves everything from a Cloudflare
**Worker**. (No game automation — this is the opposite of a botting client.)

Live at `https://osrs-clan-bot.ericbackman81.workers.dev`.

## What it does

- **Tracks players** by RuneScape name and (optionally) links them to a Discord
  user so the leaderboard can @-mention people.
- **Snapshots everyone nightly** (08:00 UTC cron) via Wise Old Man — current
  levels, XP, and EHP (efficient hours played).
- **Leaderboards** the gains race over a day / week / month, for all skills or
  just one (e.g. a Slayer race).
- **Tracks rare drops** by watching each player's Collection Log count (no plugin
  needed) — announces "new rare drops!" overnight and ranks who's pulled the most
  uniques. It knows a rare drop *happened*, not which item.
- **Celebrates milestones** — the morning after someone hits a 99, maxes, crosses
  100M/200M XP, or clears a boss-KC milestone, the bot shouts it out (via Wise Old
  Man's achievements). Which milestones are "worth a ping" is a tunable filter.
- **Ranks PvM & clues** — `/boss` for kill-count races (all bosses or one) and
  `/clues` for clue-scroll caskets, both from the stats WOM already returns.
- **Auto-posts** the weekly board to a channel you choose, on the cadence you set.
- **Introduces itself**: the first time it's used in a server it drops a short
  "here's what I do" note in that channel, and `/help` shows it any time.

## Commands

| Command | Who | What |
|---|---|---|
| `/help` | anyone | what the bot does + how to use it |
| `/track add <rsn> [@member]` · `remove <rsn>` · `list` | admin | manage the roster |
| `/iam <rsn>` | anyone | link your Discord to your RSN |
| `/leaderboard [day\|week\|month] [skill]` | anyone | the XP gains race |
| `/drops [day\|week\|month]` | anyone | rare-drop (collection log) leaderboard |
| `/boss [name] [day\|week\|month]` | anyone | PvM kill-count race (all bosses, or one) |
| `/clues [tier] [day\|week\|month]` | anyone | clue-scroll casket race |
| `/stats <rsn \| @member>` | anyone | a player's current levels & XP |
| `/config show` · `channel #channel` · `schedule daily\|weekly\|off` · `milestones all\|big\|off` | admin | live settings — no redeploy |

> Gains need a baseline, so `/leaderboard` fills in after the **second** nightly
> snapshot. `/track add` grabs a first snapshot immediately, so `/stats` works
> right away.

## How it's built

A picks-worker-style Cloudflare Worker:

```
src/discord.ts   Ed25519 request verification, REST helpers, constants
src/wom.ts       Wise Old Man client (player, bosses, activities, achievements)  ← data source
src/store.ts     D1 query layer (settings, players, snapshots, skill_xp, boss_kc, activity_score, milestones)
src/scoring.ts   leaderboard ranking — a knob that's yours to tune
src/milestones.ts  which achievements are "worth a ping" — a second tunable knob
src/index.ts     fetch() + scheduled() entry points, command routing, the welcome
scripts/register.mjs   slash-command registration
schema.sql       D1 tables
```

- **Source = Wise Old Man, store = D1.** Discord gives an interaction a 3-second
  deadline, so the bot always answers from D1 (instant) and only talks to WOM on
  the nightly cron and on `/track add`.
- **Why no real "join" detection?** An interactions-only bot (no gateway socket)
  can't see the raw "added to a server" event, so it greets on first use instead
  — which also lands the welcome in a channel people are actually in.

## Tune the leaderboard — `src/scoring.ts`

`scorePlayer()` decides who's winning. It ships on a raw-XP baseline so the bot
works today; swap in your own metric — levels gained, WOM EHP, or a diversity
bonus that rewards training many skills over grinding one. Keep it monotonic and
`test/scoring.test.ts` stays green. (Same decision as `score_player` in
`data_explorer/osrs/` — design it there, port the winner here.)

## Setup (already done for the live deploy)

```bash
npm install
npx wrangler d1 create osrs_clan          # → paste database_id into wrangler.jsonc
npx wrangler d1 execute osrs_clan --file schema.sql --remote
npx wrangler secret put DISCORD_TOKEN     # interactive — don't pipe it
npm run deploy
npm run register                          # registers slash commands to the guild
```

Public IDs (app id, public key, guild id) live in `wrangler.jsonc`; the bot token
is a Worker secret. Invite the bot with `scope=bot applications.commands` and
permissions `19456` (View Channel + Send Messages + Embed Links).
