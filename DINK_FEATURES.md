# 🆕 What's new: the bot now tracks named drops & boss PBs

The clan bot just got a real-time upgrade. On top of everything it already does
(nightly XP/boss/clue leaderboards from the hiscores), it can now see the stuff
the hiscores **can't**: *which* item you dropped, what it's worth, where it came
from, and your **fastest boss kills**.

Two new commands — `/loot` and `/pb`.

> These run off the RuneLite **Dink** plugin. If you're already posting drops in
> our Discord, you're ~30 seconds from being on these boards — see
> [`DINK_SETUP.md`](DINK_SETUP.md). Not set up? You still get every other board;
> you just won't show on these two.

---

## 💰 `/loot` — who's pulling the most, and the biggest drop

`/loot`, `/loot day`, `/loot week` (default), or `/loot month`. Ranks everyone by
total loot value in the window, and calls out the single **biggest drop**:

```
💰 Loot — last 7d
🥇 @PlayerOne — 1.4B gp
🥈 @player two — 340M gp
🥉 @PlayerThree — 96M gp

🏆 Biggest drop
@PlayerOne — Twisted bow (1.2B gp) from Chambers of Xeric
```

The old `/drops` only knew *"someone got a rare"* the next morning. `/loot` knows
it was a **Twisted bow, worth 1.2B, from CoX** — the moment it happened.

---

## ⏱️ `/pb` — race your fastest kills

`/pb boss:Zulrah` shows the fastest recorded kill time per person — a proper race:

```
⏱️ Zulrah — fastest kills
🥇 @player two — 1:32.40
🥈 @PlayerOne — 1:41.80
```

Plain `/pb` (no boss) shows the clan's most recent personal bests:

```
⏱️ Recent personal bests
• @PlayerOne — Vorkath in 2:14.60
• @player two — Zulrah in 1:32.40
```

**Why this is a big deal:** boss PB times don't exist on the hiscores *at all*.
There was no way for the bot to know them before. Now every timed kill after you
set up counts. (Use the spelling Dink shows in-game — `Zulrah`, `Vorkath`,
`TzKal-Zuk`.)

---

## Before → after

| | Before (hiscores only) | Now (with Dink) |
|---|---|---|
| Rare drops | "someone got a rare" next morning | **which item, its value, the source** — live |
| Loot race | — | total gp pulled + **biggest drop** (`/loot`) |
| Boss times | invisible | **personal-best race** (`/pb`) |
| Speed | once a night | the moment it happens |

---

## The important small print

- **Everyone still gets the basics.** `/leaderboard`, `/boss`, `/drops`, `/clues`,
  `/stats` work for the whole clan from the hiscores — **no plugin needed**. The
  new `/loot` + `/pb` are the *bonus* for whoever opts in.
- **Nothing auto-spams the channel.** These are pull-up boards — you run the
  command when you want to see them. Your existing drop feed is unchanged.
- **Privacy:** the bot only stores the fun stuff (loot, PBs, pets, clues, levels,
  quests). It **ignores deaths, trades, and GE activity** entirely — those are
  never saved.

---

## Full command list

| Command | What it shows |
|---|---|
| `/help` | what the bot does |
| `/leaderboard [day\|week\|month] [skill]` | XP gains race |
| `/boss [name] [window]` | PvM kill-count race |
| `/clues [tier] [window]` | clue-scroll casket race |
| `/drops [window]` | rare-drop (collection log) count race |
| `/stats <rsn \| @member>` | a player's current levels & XP |
| **`/loot [window]`** 🆕 | **named-drop value race + biggest drop** *(needs Dink)* |
| **`/pb [boss]`** 🆕 | **boss personal-best times** *(needs Dink)* |
| `/iam <rsn>` | link your Discord to your RSN |

*(Admins also have `/track` and `/config`.)*

---

## Might add next (shout if you want one)

Pets board, live "🎉 PET!" / "new PB!" callouts in the channel, and completionist
boards (combat achievements, diaries, quests). The plumbing's in — these are quick
to switch on. Full menu: [`DINK_ROADMAP.md`](DINK_ROADMAP.md).

**Want in? → [`DINK_SETUP.md`](DINK_SETUP.md) (~30 seconds).**
