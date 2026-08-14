# Get your drops & PBs on the clan bot — the 1-minute setup

**Totally optional. Nothing breaks if you skip it.** The bot already tracks your
stats from the public hiscores every night — this just adds the *fun* real-time
stuff on top: your **named drops**, **biggest loot**, and **boss personal-best
times**. It's the same RuneLite **Dink** plugin you already use to post drops in
Discord — you're just adding one more address for it to send to.

> ⚠️ This is **ToS-safe** — Dink only watches your own client and reports; it's
> not a bot or a cheat (RuneLite is Jagex-approved). It does **not** log you in,
> click for you, or automate anything.

---

## What you get

| Command | What it shows |
|---|---|
| `/loot [day\|week\|month]` | Who's pulled the most gp in loot, **+ the single biggest drop** |
| `/pb [boss]` | Fastest kill times — race your mates (e.g. `/pb boss:Zulrah`) |

Boss PB times **don't exist** in the nightly hiscores at all — this is the only
way the bot can ever see them.

---

## Before you start

You almost certainly already have this — if your drops show up in the clan's
Discord drop channel, **Dink is already installed.** You're just adding a second
destination. (No Dink yet? In RuneLite: **Configuration 🔧 → Plugin Hub → search
"Dink" → Install**, then come back here.)

---

## The one step

1. In RuneLite, click the **wrench 🔧** (Configuration) in the top-right.
2. Search **Dink** and click it to open its settings.
3. Find **"Primary Webhook URLs"** — the box where your Discord webhook already
   lives. It takes **one URL per line**.
4. Add a **new line** with the bot's address (keep your existing Discord line —
   both work at once):

   ```
   https://osrs-clan-bot.ericbackman81.workers.dev/dink?key=ASK-ERIC-FOR-THE-KEY
   ```

   > 🔑 **Get the real `key=` value from Eric** (Discord DM). It's a shared
   > password that stops randoms from spamming the bot — don't post it in a public
   > channel. Paste it exactly, no spaces.

5. Done. Really.

---

## Turn on the notifications the bot reads

These are on by default in Dink, but double-check they're ticked so the bot sees
your stuff:

- **Loot** → drops & their value (`/loot`)
- **Kill Count** → boss kills **and PB times** (`/pb`)
- **Collection Log**, **Pet**, **Clue Scroll**, **Level** → nice extras

You don't need to touch screenshots — the bot ignores images, so leave that
however you like.

---

## Did it work?

Get a drop or kill a boss, then in Discord run `/loot` or `/pb`. Your name should
show up. (Give it a few seconds after the in-game event.) `/help` also lists the
new commands.

---

## What the bot sees (and doesn't)

- ✅ It stores: **loot, boss kills & PB times, pets, clues, levels, quests,
  diaries, combat achievements** — the flex stuff.
- 🚫 It **discards on arrival**: **deaths, trades, and Grand Exchange** activity.
  Those are never saved. (No "how much gp you fed the Wildy" board unless the
  clan later votes one in.)
- 🔕 It does **not** auto-post anything right now. Your drops only appear when
  someone runs `/loot` / `/pb`. Your existing Discord drop feed is separate and
  unchanged.
- 👥 It only records events for **tracked clan members** — if you're not on
  `/track list`, ask Eric to add your RSN.

> **Extra-cautious?** If you'd rather the bot never even *receives* your
> deaths/trades, use Dink's per-notifier **"Webhook Override"** to send only
> **Loot** and **Kill Count** to the bot URL, and leave everything else going to
> your Discord webhook only.

---

## Don't want to bother?

Cool — do nothing. You're still on every nightly leaderboard (`/leaderboard`,
`/boss`, `/drops`, `/clues`) from the hiscores like always. You just won't appear
on `/loot` or `/pb`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing shows on `/loot` or `/pb` | Double-check the URL + `key=` are exact (no trailing spaces, correct key from Eric). Make sure the matching notifier (Loot / Kill Count) is ticked in Dink. |
| "No personal bests for X" | Use the spelling Dink shows in-game (e.g. `Zulrah`, `Vorkath`, `TzKal-Zuk`). PBs only count *timed* kills after setup — old kills won't backfill. |
| Your RSN isn't tracked | Ask Eric to `/track add <your rsn>` (or `/iam <rsn>` to link your Discord). |
| Still stuck | Ping Eric — he can check the logs to see if your events are arriving. |
