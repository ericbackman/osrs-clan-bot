# PLAYBOOK — osrs-clan-bot

> Operations manual. Read README.md first for context; this file is PROCEDURE.
> Tier rule: **Sonnet executes what's written here; Opus may change it (log why in
> Maintenance); Eric approves anything public or irreversible.** Not covered here ->
> stop, leave a note, don't improvise.
>
> Provenance: created 2026-07-04 (Fable-week Track 5). See workspace [PLAYBOOKS.md] for
> the doc-role model and [_fable_week/playbooks-report.md] for why this exists.
>
> No CLAUDE.md exists for this repo (README-driven). This file does not duplicate
> README.md's architecture map, command table, or setup walkthrough — read those
> there.

## 1. System map

- **What**: ToS-safe Discord bot for "The Dawg Pound" OSRS friend clan. Cloudflare
  Worker answers 9 slash commands from Cloudflare D1; the only machine-driven
  recurring op is a nightly cron that refreshes every tracked player via the
  **Wise Old Man** API, stores a snapshot (skills + boss KC + activities),
  announces new rare drops **and milestones** (99s/maxes/KC via WOM achievements),
  and optionally auto-posts the weekly gains board.
- **Live URL**: `https://osrs-clan-bot.ericbackman81.workers.dev`
- **Schedule**: nightly cron `0 8 * * *` (08:00 UTC) — `osrs-clan-bot/wrangler.jsonc`
  `triggers.crons`. Registered in workspace [`AUTOMATION.md`](../AUTOMATION.md#L101)
  under Layer 3 (Cloudflare Worker crons).
- **D1 database**: `osrs_clan` (binding `DB`, id `ac74f21d-1ae4-4fa8-b118-a67f829ddd18`
  — `wrangler.jsonc`). Tables: `settings`, `players`, `snapshots` (append-only,
  one row per player per capture), `skill_xp`, `boss_kc`, `activity_score`
  (per-snapshot child rows), and `announced_milestones` (milestone dedup) — see
  `schema.sql`. `boss_kc`/`activity_score`/`announced_milestones` were added
  2026-07-08 (§8); apply with the additive `wrangler d1 execute ... --file schema.sql`
  step (OP-4) before deploying the code that reads them.
- **Source of truth**: Wise Old Man (`api.wiseoldman.net/v2`) is the stats source;
  D1 is the store. Discord's 3s interaction deadline means commands always answer
  from D1, never call WOM live (exception: `/track add` grabs one immediate
  snapshot — `src/index.ts` `handleTrack`, sub `add`).
- **Entry points**: `src/index.ts` `fetch()` (interactions) and `scheduled()`
  (cron) -> `runDailySnapshot()` (~line 288).
- **Eric's metric**: `scorePlayer()` in `src/scoring.ts` (line 44) ranks the
  leaderboard — owner:Eric, see section 5.
- **No staging** — the guild is production. Verify changes with ephemeral,
  read-only commands (`/help`, `/stats`) in the live server, never test posts.

## 2. Health check — run first

Confirm last night's cron actually landed a snapshot for every tracked player.

```bash
cd osrs-clan-bot
npx wrangler d1 execute osrs_clan --remote --command "SELECT captured_at, COUNT(*) AS n FROM snapshots GROUP BY captured_at ORDER BY captured_at DESC LIMIT 3"
```

**Expected output**: 3 rows, most-recent `captured_at` within the last ~24h
(cron runs 08:00 UTC), and `n` for that row equal to the tracked-player count —
cross-check with:

```bash
npx wrangler d1 execute osrs_clan --remote --command "SELECT COUNT(*) AS tracked FROM players"
```

If `n` < `tracked`, one or more players silently failed that night (see section 4
"player skipped"). If there's no row for last night at all, the cron itself
didn't fire or `runDailySnapshot` threw before the per-player loop — check:

```bash
npx wrangler tail osrs-clan-bot
```

(live tail only — it does not show past invocations; for historical cron runs
use the Cloudflare dashboard: Workers & Pages -> osrs-clan-bot -> Logs, or
Triggers -> Cron Triggers to see recent invocation times/status.)

Also sanity-check settings are what's expected:

```bash
npx wrangler d1 execute osrs_clan --remote --command "SELECT * FROM settings"
```

Expect a `schedule` row (`daily`/`weekly`/`off`) and, if not `off`, a
`post_channel_id` row.

## 3. Operations

### OP-1: Verify the nightly snapshot + auto-post

- **Trigger**: routine — run this whenever asked "did the bot post last night" /
  as part of any health check.
- **Steps**: run the Health Check queries above.
- **Verify**: snapshot row count for the latest `captured_at` == tracked-player
  count; if `schedule` is `daily` or (`weekly` AND today is Monday UTC), a
  "Weekly gains" embed should exist in the configured Discord channel around
  08:00 UTC.
- **If it fails**: see section 4. A **missing weekly board on a non-Monday when
  schedule='weekly' is expected, not a failure** (`isMonday` check,
  `src/index.ts` ~line 328).
- **Note (for editors):** the "row count == tracked players" verify relies on
  `capturedAt` being set **once per cron run** (`src/index.ts` ~line 291, before
  the per-player loop). If a future edit moves it inside the loop (true per-player
  timestamps), `GROUP BY captured_at` silently returns one row per player and this
  check breaks — change the query too.

### OP-2: Deploy a code change

- **Trigger**: after any edit under `src/` or `scripts/`.
- **Pre-flight**: `cd osrs-clan-bot`
- **Steps**:
  ```bash
  npm test          # vitest run — test/scoring.test.ts must stay green
  npm run check     # tsc --noEmit
  npm run deploy    # wrangler deploy
  ```
- **Verify**: all three commands exit 0. Then run a read-only command in the
  live Discord server — `/help` or `/stats <rsn>` — and confirm it responds.
  **Never post a test message to the live channel** (see section 7).
- **If it fails**: `npm test` red on a `scorePlayer`/`rankGains` change usually
  means monotonicity broke (section 5) — do not weaken the test to pass it.
  `npm run deploy` failing on auth means the Cloudflare API token/login expired;
  re-run `npx wrangler login` (interactive, do not pipe credentials).

### OP-3: Re-register slash commands

- **Trigger**: only when command definitions in `scripts/register.mjs` change
  (new command, new option, new choice).
- **Pre-flight**: `DISCORD_TOKEN` must be resolvable — from `.dev.vars`
  (gitignored, copy from `.dev.vars.example`) or already in the environment.
  App/guild IDs come from `wrangler.jsonc` `vars` (public, not secret).
- **Steps**:
  ```bash
  npm run register
  ```
- **Verify**: console prints `Registered 9 commands to guild 690589122833678427.`
  (count matches however many top-level commands are in `scripts/register.mjs`
  at the time — 9 after the 2026-07-08 `/boss` + `/clues` additions). The
  new/changed command appears in the Discord guild **immediately** — it's
  guild-scoped, not global.
- **If it fails**: exit code 1 with `Missing config...` means `DISCORD_TOKEN` /
  `DISCORD_APPLICATION_ID` / `GUILD_ID` didn't resolve — check `.dev.vars`
  exists and is non-empty. **Never enter `DISCORD_TOKEN` by piping it through
  PowerShell** — BOM corruption (workspace-wide gotcha); enter it via
  `npx wrangler secret put DISCORD_TOKEN` interactively, or write `.dev.vars`
  directly with a file-write tool, not a piped echo.

### OP-4: D1 schema change (additive only)

- **Trigger**: rare — adding a feature that needs a new table/column (e.g. a
  deferred Dink named-drops feature).
- **Pre-flight**: confirm the new SQL is `CREATE TABLE IF NOT EXISTS` /
  `ALTER TABLE ... ADD COLUMN` style — additive only. Non-additive changes
  (`DROP`, destructive `ALTER`) are out of scope for this playbook — stop, see
  section 6.
- **Steps**:
  ```bash
  npx wrangler d1 execute osrs_clan --file schema.sql --remote
  ```
- **Verify**: `npx wrangler d1 execute osrs_clan --remote --command "SELECT * FROM <new_table> LIMIT 1"` runs without error (empty result is fine — proves the table exists).
- **If it fails**: SQL error on apply means the statement wasn't idempotent —
  fix `schema.sql` to `IF NOT EXISTS` form and re-run (safe to re-run in full,
  per file header comment).

## 4. Failure modes & recovery

| Symptom | Cause | Fix | Verify |
|---|---|---|---|
| One player missing from last night's snapshot batch | Per-player WOM call failed (404/renamed/rate-limited) — caught individually, `console.error`, loop continues (`src/index.ts` `runDailySnapshot`, the `try/catch` around `wom.updatePlayer`) | Usually self-heals — WOM tracks renames server-side (`src/wom.ts` header comment). Check `npx wrangler tail osrs-clan-bot` while re-triggering, or wait for tomorrow's run | Re-run the health-check count query the next day; row count matches tracked players |
| No rare-drops message posted overnight | Either no one's collection-log count rose, or the announce step threw (`drops announce skipped: ...` in logs) | Check `wrangler tail` / CF dashboard logs for that string; if `schedule='off'` or `post_channel_id` unset in `settings`, that's expected — check via the settings query in section 2 | `SELECT * FROM settings` shows `post_channel_id` set and `schedule != 'off'` |
| No milestone message ever posts, or a player's history never announces | **Expected on a player's FIRST cron after 2026-07-08:** they're seeded silently (all current achievements recorded, nothing announced) so we don't dump years of 99s at once — real milestones announce from the *next* one earned. Also expected if `schedule='off'`/no channel. Per-player fetch errors log `milestones skipped for <name>: ...` | Confirm the player has a row in `announced_milestones` (seeding ran): `SELECT COUNT(*) FROM announced_milestones WHERE rsn='<canonical rsn>'`. If a specific fetch fails, check `wrangler tail` for the skip line — usually a transient WOM 404/429, self-heals next night | A milestone earned *after* the seeding night appears in the channel; `announced_milestones` has a `__seeded__` sentinel row for that player |
| A player's milestone announces twice | Dedup relies on stable WOM achievement `name` strings keyed by canonical `rsn`; a mid-flight rsn change could re-seed under a new key | Rare — confirm the `rsn` in `players` matches what `announced_milestones` used; do not delete rows to "fix" (that re-announces). Escalate if it recurs | Each `(rsn, milestone)` pair appears once in `announced_milestones` (PRIMARY KEY enforces it) |
| No weekly board posted | `auto-post skipped: ...` logged, OR `schedule='weekly'` and today isn't Monday UTC (expected, not a bug), OR `schedule='off'` | Check logs for the skip message; check `isMonday` logic only applies when `schedule='weekly'` | Settings query + `new Date().getUTCDay() === 1` check |
| `/leaderboard` or `/drops` says "not enough history" for a newly-added roster | Gains need **two** nightly snapshots as a baseline — expected for brand-new players (README callout) | None needed — wait for the next nightly cron | `/stats <rsn>` should already work (immediate snapshot on `/track add`); `/leaderboard` works after night 2 |
| `npm run register` exits 1 with a config message | `DISCORD_TOKEN`/`DISCORD_APPLICATION_ID`/`GUILD_ID` didn't resolve | Confirm `.dev.vars` exists (copy from `.dev.vars.example`) with a valid token, or the env var is set in-shell | Re-run `npm run register`; expect the `Registered N commands...` success line |
| Interactions return HTTP 401 / Discord shows "app didn't respond" | `DISCORD_PUBLIC_KEY` mismatch, or the Discord bot token was rotated/expired without updating the Worker secret | Confirm `DISCORD_PUBLIC_KEY` in `wrangler.jsonc` matches the Developer Portal; if the token itself is bad, this is a stop-condition (section 6) — token rotation is Eric's | `/help` responds successfully in Discord after the secret is corrected |
| A `scorePlayer`/`rankGains` edit breaks monotonicity | More XP in a skill lowered a player's score | `npm test` — `test/scoring.test.ts` "monotonicity" case goes red | Fix the scoring function until `npm test` is green; never edit the test to force a pass |

## 5. Tuning knobs

| Param | Where | Current | Safe range | Owner |
|---|---|---|---|---|
| `scorePlayer()` leaderboard metric | `src/scoring.ts:44` (boxed "MAKE IT YOURS" comment); design twin `data_explorer/osrs/scoring.py` | raw-XP sum | any monotonic function of `SkillGain[]` — more XP in a skill must never lower score (`test/scoring.test.ts` enforces this) | **Eric** — propose a new metric, never change ranking semantics unilaterally |
| Milestone chattiness (`milestones_mode`) | **D1 `settings`, live via `/config milestones`** (admin Discord command — no redeploy). The mode → filter mapping is `shouldAnnounceMilestone(m, mode)` in `src/milestones.ts` | `all` (default when unset) | `all` / `big` / `off` — a TASTE call, not correctness (`test/milestones.test.ts` pins the mapping) | **Admins (Eric/Stevie)** via `/config`. Cron records every processed milestone, so changing modes never floods history |
| Auto-post channel + cadence | D1 `settings` table, set via `/config channel` / `/config schedule` (admin-only Discord command) | varies per clan config — read via `SELECT * FROM settings` or `/config show` | `daily` / `weekly` / `off` | **Admins (Eric/Stevie)** via Discord command — not a file edit |
| Cron time | `wrangler.jsonc` `triggers.crons` | `"0 8 * * *"` (08:00 UTC) | any valid cron string; keep once-daily | agent (mechanical — redeploy required after changing) |
| WOM politeness delay between players | `src/index.ts` `runDailySnapshot`, ~line 300, `setTimeout(r, 300)` | 300ms | do not shrink — WOM asks for polite, identifiable usage (also see `src/wom.ts` `USER_AGENT`) | agent, but treat as a floor not a target |
| Leaderboard/drops display cap | `src/index.ts` `boardLines(ranked, limit = 15)` line 61; `/drops` handler `.slice(0, 15)` line 258 | 15 | cosmetic — any positive integer | agent |

## 6. Escalate to Eric (stop conditions)

- Any non-additive D1 change (dropping/rewriting `snapshots` — the append-only
  gains history has **no documented backup**).
- Discord token appears leaked, or Discord REST calls start failing with 401 —
  token rotation happens in the Developer Portal, Eric's account.
- Wise Old Man starts returning repeated 429s across the whole roster (not one
  player) — a contact/API-key decision is Eric's, not a code fix.
- Any request to build a deferred feature: Dink named-item drops, a CF
  dashboard, or `/ask` (LLM command reading `ANTHROPIC_API_KEY` per
  `.dev.vars.example`) — these are unbuilt product decisions pending Eric.
- Changing what the bot posts publicly in the clan channel beyond what
  `/config` already exposes (new message formats/cadence) — Eric approves what
  the clan sees.
- Changing `scorePlayer`'s ranking semantics (not mechanical fixes) — propose,
  don't ship.

## 7. Do-not list

- **Never** run `DROP`/`DELETE`/destructive `UPDATE` against the remote
  `osrs_clan` D1. Schema changes must stay additive (`CREATE ... IF NOT EXISTS`
  pattern in `schema.sql`).
- **Never** commit or print `.dev.vars` or any `*.env` file (gitignored;
  `.gitleaks.toml` present). `DISCORD_TOKEN` enters only via interactive
  `npx wrangler secret put DISCORD_TOKEN` — never piped through PowerShell
  (BOM corruption; workspace-wide gotcha).
- **`osrs_clan_companion.env` at the repo root holds a LIVE plaintext Discord bot
  token** and is read by no script (orphaned; currently gitignored, so not in git
  history). Confirm it stays gitignored before any repo-wide action (`git add -A`,
  tarball, zip-and-send) and treat exposing/copying/committing it as equivalent to
  leaking `DISCORD_TOKEN` (§6 stop condition). It should ideally be deleted and the
  token rotated — `TODO(Eric)` (see the report's incidental findings).
- **Never** post test/debug messages to the live Discord channel — it's a real
  friend group's server. Verify with ephemeral, read-only commands (`/help`,
  `/stats`) instead.
- **Never** shrink or remove the WOM `User-Agent` (`src/wom.ts`) or the 300ms
  per-player delay (`src/index.ts`) — the free WOM API asks for polite,
  identifiable usage; losing that risks the whole roster getting rate-limited.
- **Never** add game-automation or RuneLite-plugin-dependent features — the
  bot's entire premise is ToS-safe, read-only public stats (README opening
  line). This is a hard product boundary, not a style preference.
- **Do not** change `scorePlayer`'s ranking semantics without Eric — it's
  explicitly his metric. Mechanical/refactor changes must keep
  `test/scoring.test.ts` green.

## 8. Maintenance

Update this playbook in the SAME change as any operation change.

- 2026-07-04 — initial playbook created (Fable-week Track 5), grounded against
  README.md, wrangler.jsonc, schema.sql, src/*.ts, scripts/register.mjs,
  test/scoring.test.ts, and AUTOMATION.md L101.
- 2026-07-08 — **zero-install feature batch** (Eric-picked): milestone
  announcements (`src/milestones.ts` + `announced_milestones` table + nightly
  achievements fetch in `runDailySnapshot`), and `/boss` + `/clues` leaderboards
  (`boss_kc`/`activity_score` tables + `handleBoss`/`handleClues`). New public
  message format = the "🎉 Milestones!" nightly embed (Eric-approved). New tuning
  knob `shouldAnnounceMilestone` (§5). Deploy order: apply schema (OP-4) → deploy
  (OP-2) → re-register 9 commands (OP-3). First cron post-deploy seeds milestones
  silently (§4). Deferred, still pending Eric: weekly SOTW (needs a WOM group +
  verification code as a secret), Dink named drops, `/ask`.
