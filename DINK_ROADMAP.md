# DINK_ROADMAP — what the plugin unlocks, and in what order

> Product roadmap / decision menu.
>
> **STATUS (2026-07-18): Phase 0 + Phase 1 SHIPPED.** The receiver (`POST /dink`),
> `dink_events` table, privacy allowlist, and `/loot` + `/pb` are live in code
> (silent-capture — no channel posting). See `PLAYBOOK.md` §8 / OP-6 and
> `DINK_SETUP.md`. Phases 2–3 and the deferred tiers below are still a menu.
>
> Provenance: created 2026-07-18. Prompted by "the whole clan has Dink now — what
> are we leaving on the floor?" Grounded against `README.md`, `PLAYBOOK.md`,
> `schema.sql`, `src/*.ts`, and Dink's own docs (see Sources). Supersedes the
> "deferred, pending Eric" placeholder in [PLAYBOOK.md](PLAYBOOK.md) §6 / §8
> (2026-07-09 note).

---

## 1. Why this exists (the decision context)

The bot has exactly one data source today: **Wise Old Man**, polled once a night
(`0 8 * * *`). WOM reads the public Hiscores, which are **aggregate counters**.
That gives the bot three permanent ceilings:

1. **Once-a-day** — everything is "next morning."
2. **Numbers, not events** — it sees a counter *changed*, never the *thing that
   happened*. Hence [README.md](README.md): *"It knows a rare drop happened, not
   which item."*
3. **Hiscores-only** — it can't see anything the Hiscores don't track (deaths,
   pets, PB times, GE, trades…), and can't see a metric until you're *ranked* on
   it.

**Dink is a different kind of sensor**: a real-time, per-event, item-level stream
that Dink POSTs to any URL. It breaks all three ceilings at once.

**What changed** is *not* safety. Dink/RuneLite is Jagex-sanctioned and only
*observes and reports* — it's the same "read-only, ToS-safe, opposite-of-a-botting-
client" posture the bot already has. The only premise "everyone has Dink" retires
is the **zero-install selling point** — and the clan already paid that cost
voluntarily. The clan even already runs a raw **Dink → Discord** feed
([PLAYBOOK.md](PLAYBOOK.md) 2026-07-09) — but it's decoration: messages dumped in a
channel that **the bot never sees, stores, dedupes, or ranks.**

> ⚠️ This crosses a line the PLAYBOOK do-not list currently draws ("never add
> RuneLite-plugin-dependent features"). That was Eric's boundary; lifting it is a
> deliberate edit to the playbook, made when we ship — not silent drift.

---

## 2. Principles (apply to every phase)

- **Hybrid, not replacement.** WOM stays the *universal baseline* — it covers
  everyone with zero setup, including buddies who don't run Dink. Dink *layers*
  real-time richness on top for those who opt in. We never rip out WOM.
- **Additive only.** New tables/columns via `CREATE TABLE IF NOT EXISTS` /
  `ADD COLUMN` (PLAYBOOK OP-4). Never touch the append-only `snapshots` history.
- **Reuse the codebase's dedup idiom.** Everything append-only with a `UNIQUE`
  key + `INSERT OR IGNORE`, exactly like `snapshots`, `boss_kc`, and
  `announced_milestones` already do.
- **Public posting is an Eric-gate.** Same doc-role model as today: each new thing
  the clan *sees* is approved before it ships.
- **Privacy tiers are the default, not an afterthought** (see §4).

---

## 3. Phase 0 — the foundation (this is the real work)

Every feature below is small *once this exists*; Phase 0 is where the engineering
lives. One-time build:

| Piece | What | Notes |
|---|---|---|
| **Receiver route** | `POST /dink` next to `/interactions` in `src/index.ts` | The Worker is already an HTTP server ([src/index.ts:589](src/index.ts)). No Discord 3s deadline applies — it's not an interaction. |
| **Auth** | Shared secret in the URL (`/dink?key=…`) or a header, checked before any write | Dink lets you point at an arbitrary URL, so the secret rides along. Without it, anyone could POST a fake Twisted bow. |
| **Body parsing** | Handle both `application/json` and `multipart/form-data` | Dink sends multipart when a screenshot is attached; read the `payload_json` part, ignore the image. (Or tell users to disable screenshots on the custom webhook.) |
| **Identity mapping** | Map `playerName` → `canonicalRsn()` → `players` row; opportunistically learn `dinkAccountHash` into a new `players.account_hash` column | Start on RSN (reuses existing `canonicalRsn`). Harden to account-hash later — it survives renames natively, unlike RSN. |
| **Unknown-sender policy** | Ignore events from RSNs not in the roster | Doubles as a second spoof guard: only known players count. |
| **Storage** | Append-only `dink_events` table, idempotency `UNIQUE` key, `INSERT OR IGNORE` | Key ≈ (rsn/hash, type, natural-key, timestamp). Same pattern as `snapshots`. |
| **Pure parser + tests** | A `parseDinkEvent(json)` pure function, unit-tested against fixtures | Mirrors `parsePlayer`/`parseAchievements` in `src/wom.ts` — no IO, fixture-tested. |
| **Silent-capture mode** | Phase 0 stores events but posts *nothing* | Lets us verify against the existing raw feed before the bot says a word. |

**Rollout:** each buddy adds the Worker URL as an *additional* Dink webhook (the
raw Discord feed keeps working in parallel). A `/dink setup` ephemeral command
could DM them the exact URL+key. Decide later whether the bot *takes over* posting
(curated + deduped) or just captures alongside the raw feed.

### 3.1 Effort for players — almost none

- **Baseline = zero.** WOM covers everyone with no action. A buddy who touches
  nothing is still fully tracked; Dink is purely additive.
- **The only task: one paste, once.** They've already installed + configured Dink
  (that's the existing raw feed). Feeding the bot = adding *one more* webhook URL
  (the Worker's, with the key) to a field they've already used. Dink supports
  multiple targets, so the Discord feed stays untouched. ~30s, one-time,
  per-person. `/dink setup` can DM the exact string so no one mistypes the key.
- **Coverage caveat:** the bot only sees what each person's Dink is *configured to
  send*. Common notifiers (loot/level/KC/coll-log/pet/clue) are usually already on
  → Phase 1 likely needs nothing from them. A feature like `DEATH` needs that
  notifier toggled on (one click) by anyone who wants it counted.
- **Not their problem (all bot-side):** dedup, spam thresholds, and screenshot/
  multipart handling — the Worker parses-and-ignores any attached image.
- **No new fragility:** stop running RuneLite / uninstall Dink / never paste the
  URL → that player silently falls back to the nightly WOM view. Nothing breaks.

---

## 4. Event catalog — the full menu, with privacy defaults

Dink `type` values → what each unlocks. **Effort is post-foundation** (S = a
parser branch + a board; M = also needs new UI/query shape). Privacy tiers:
**Public** (flex/celebrate), **Opt-in** (off until the clan flips it on),
**Private** (off; sensitive), **Internal** (never posted — infrastructure).

| Dink `type` | Unlocks | New / Upgrade | Privacy | Effort | Phase |
|---|---|---|---|---|---|
| `LOOT` | Named-drop feed + **"drop of the week"** (by value or rarity), total-loot-value race | Upgrade of `/drops` | Public *(min-value threshold)* | M | **1** |
| `KILL_COUNT` | Live boss kills + **PB times** + raid team/splits; fastest-X boards, live "new PB!" | Upgrade of `/boss` + milestones | Public | M | **1** |
| `COLLECTION` | Coll-log slot **with item name** + rank progress; "first in clan to X" | Upgrade of `/drops` signal | Public | S | **1** |
| `PET` | Pet-drop celebrations + pet-collection race | New *(Hiscores can't see pets)* | Public | S | **1** |
| `LEVEL` | Live 99 / max / level-up shouts (the moment, not next morning) | Upgrade of milestones | Public | S | 2 |
| `XP_MILESTONE` | Any-interval XP milestones (every 10M, etc.), live | Upgrade of milestones | Public | S | 2 |
| `CLUE` | Per-casket reward items + value; biggest-clue board; "3rd age!" moments | Upgrade of `/clues` | Public | S | 2 |
| `COMBAT_ACHIEVEMENT` | CA points leaderboard + tier-unlock celebrations | New | Public | S | 2 |
| `ACHIEVEMENT_DIARY` | Diary completion race by region/tier | New | Public | S | 2 |
| `QUEST` | Quest-cape race, quest-point board | New | Public | S | 2 |
| `SLAYER` | Slayer streak + points board, task-of-the-day (richer than WOM slayer XP) | New | Public | S | 2 |
| `LOGIN` / `LOGOUT` | **Full-account stat sync on login** → intra-day leaderboard freshness, less nightly-WOM reliance for active players | Infrastructure | Internal | M | 2–3 *(optional)* |
| `SPEEDRUN` | Quest speedrun PB board | New | Public | S | 3 |
| `DEATH` | "Fed to the Wildy" / clown-of-the-week, gp-lost tracking | New | **Opt-in** *(off default)* | S | 3 |
| `PLAYER_KILL` | PK leaderboard *(niche for a PvM clan)* | New | Opt-in | S | 3 |
| `BARBARIAN_ASSAULT_GAMBLE` | High-gamble luck tracking | New | Public *(niche)* | S | 3 |
| `LEAGUES_*` (`AREA`/`RELIC`/`MASTERY`/`TASK`) | Seasonal Leagues boards (only live during a League) | New | Public *(seasonal)* | M | 3 *(seasonal)* |
| `GRAND_EXCHANGE` | Flipping / merch board | New | **Private** *(reveals wealth + strategy)* | S | Deferred |
| `TRADE` | Loans / gifts between members | New | **Private** *(wealth transfer between named people)* | S | Deferred |
| `GROUP_STORAGE` / `GROUP_BANK_CONTENTS` | GIM shared-bank activity *(only if you're a GIM group)* | New | **Private** | M | Deferred |
| `CHAT` | Custom game-message pattern triggers (advanced catch-all) | New | **Off** *(advanced; can capture private chat)* | M | Deferred |

---

## 5. Phased build order

**Phase 0 — Foundation. ✅ SHIPPED (2026-07-18).** §3. Silent capture, no posting.
Unblocks everything. Privacy allowlist (`CAPTURED_TYPES`) enforces the tiers below
in code — sensitive types are dropped at the door, not just unshown.

**Phase 1 — The flex trio. ✅ SHIPPED (2026-07-18)** (highest value, lowest risk,
all public): `LOOT` + biggest-drop highlight (`/loot`), `KILL_COUNT` with PB times
(`/pb`), `PET` (captured; a `/pets` board is a trivial follow-up). Directly
upgrades the bot's *weakest* feature (`/drops` "a drop happened" → `/loot`
"Twisted bow from CoX, ~1.2B"). Note: `/loot` and `/pb` are **pull** commands;
real-time *posting* of these is intentionally deferred (avoids double-posting the
raw feed) — a `/config`-gated opt-in when Eric wants it.

**Phase 2 — Completionist boards** (all public, all small once foundation exists):
`LEVEL`, `XP_MILESTONE`, `CLUE` rewards, `COMBAT_ACHIEVEMENT`, `ACHIEVEMENT_DIARY`,
`QUEST`, `SLAYER`. Optionally wire `LOGIN` full-sync for intra-day freshness.

**Phase 3 — Spicy & seasonal** (content-rich, need a toggle): `DEATH`
("clown of the week"), `PLAYER_KILL`, `BA_GAMBLE`, `LEAGUES_*`.

**Deferred / off by default** (privacy): `GRAND_EXCHANGE`, `TRADE`,
`GROUP_STORAGE`, `CHAT`. Available, off, flipped on only with explicit clan opt-in.

---

## 6. Cross-cutting decisions for Eric (independent of which features)

These shape the foundation, so they're worth deciding up front:

1. **Drop ranking metric** — how is "best drop" scored? Raw **GP value** (favors
   big-ticket PvM gear), **rarity / drop-rate** (rewards luck over gear), or a
   **blend**? Same `scorePlayer()`-style judgment call that's explicitly yours in
   this codebase.
2. **Auth model** — shared secret in the URL vs a header; who holds the key; one
   shared key vs per-player.
3. **Privacy posture** — confirm the tiers in §4. The one real toggle to decide
   now: is `DEATH` fun-content (on) or off-by-default for this friend group?
4. **Identity** — RSN mapping now, account-hash hardening later? Or add
   `players.account_hash` from day one?
5. **Posting relationship** — keep the raw Dink → Discord feed *and* capture in
   parallel (safest), or have the bot **take over** posting curated/deduped
   messages and retire the raw feed?
6. **Onboarding** — how buddies get the URL+key: a `/dink setup` ephemeral
   command that DMs it, or a pinned instruction?
7. **Spam control** — minimum loot value before a `LOOT` event is board-worthy
   (avoid drowning in 5k drops).

---

## 7. Out of scope (unchanged boundaries)

- **WOM stays.** Universal baseline for everyone, Dink-user or not.
- **No automation.** Dink observes; the bot never plays the game. Hard line.
- **Schema stays additive.** No destructive D1 changes (PLAYBOOK §7).
- **Public message changes stay Eric-gated.** Every new thing the clan sees is
  approved before ship, and the PLAYBOOK boundary + do-not list get a deliberate
  edit in the same change.

---

## Sources

- [Dink plugin (pajlads/DinkPlugin)](https://github.com/pajlads/DinkPlugin) — notifier list, arbitrary-webhook support, account hash.
- [Dink JSON examples](https://github.com/pajlads/DinkPlugin/blob/master/docs/json-examples.md) — `type` enum, top-level fields, per-type `extra` shapes.
- [Dink on RuneLite Plugin Hub](https://github.com/runelite/plugin-hub/blob/master/plugins/dink) — hub listing.
