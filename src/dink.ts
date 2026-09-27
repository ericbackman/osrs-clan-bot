// Dink event normalizer. The RuneLite **Dink** plugin POSTs one webhook per
// in-game event to our /dink route; this module turns that payload into a flat
// row the store can rank. It is PURE (no IO) so it's fixture-testable, mirroring
// parsePlayer/parseAchievements in wom.ts.
//
// Why this exists: WOM (our baseline) polls the Hiscores nightly and only sees
// aggregate counters — it knows a drop *happened*, never which item, and can't
// see boss PB times at all. Dink is the opposite sensor: real-time, per-event,
// item-level. We layer it on top of WOM (never replacing it) for whoever opts in.
//
// We read ONLY the structured `extra` object (+ top-level metadata), never the
// human-facing `content`/`embeds` — per Dink's own guidance for custom servers.
// Payload shape + `type` enum: github.com/pajlads/DinkPlugin/blob/master/docs/json-examples.md
//
// IMPORTANT — dedup: Dink payloads carry no reliable event timestamp and Dink
// RETRIES failed deliveries with an identical body. So `dedupKey` is built from
// the fields that distinguish real events (source, kc, item…), NEVER the receive
// time — that's what makes INSERT OR IGNORE idempotent against retries.

import { canonicalRsn } from "./store";

/**
 * Privacy allowlist — the ONLY Dink types we store, matching the "Public /
 * celebratory" tier in DINK_ROADMAP.md. Everything else Dink might send (DEATH,
 * GRAND_EXCHANGE, TRADE, GROUP_STORAGE, PLAYER_KILL, CHAT, LOGIN…) is dropped at
 * the door — never written to D1 — because those are personal (wealth, deaths,
 * trades) and marked opt-in/off in the roadmap. This makes "privacy by default"
 * a property of the receiver, not a promise in a setup guide. To opt a type in
 * later, add it here (a deliberate, reviewable one-line change).
 */
export const CAPTURED_TYPES = new Set<string>([
  "LOOT",
  "KILL_COUNT",
  "PET",
  "COLLECTION",
  "CLUE",
  "LEVEL",
  "XP_MILESTONE",
  "COMBAT_ACHIEVEMENT",
  "ACHIEVEMENT_DIARY",
  "QUEST",
  "SLAYER",
  "SPEEDRUN",
  "TOA_UNIQUE",
  "BARBARIAN_ASSAULT_GAMBLE",
  "LEAGUES_AREA",
  "LEAGUES_MASTERY",
  "LEAGUES_RELIC",
  "LEAGUES_TASK",
]);

/** A Dink event normalized to the fields our boards actually use. */
export interface DinkEvent {
  playerName: string; // Dink's spelling (display); store maps to canonical rsn
  accountHash: string | null; // persistent, rename-proof id (stored for future hardening)
  type: string; // LOOT, KILL_COUNT, PET, COLLECTION, CLUE, LEVEL, … (uppercased)
  source: string | null; // boss/npc/activity/clue tier that produced it
  item: string | null; // headline item (loot: most valuable; pet: name; coll: item)
  itemId: number | null;
  quantity: number | null;
  value: number | null; // gp value for the event
  rarity: number | null; // drop probability (0..1) if Dink provided it
  kc: number | null; // kill count at the event
  pbSeconds: number | null; // personal-best time (s) — only when this kill was a PB
  detail: string | null; // freeform human string (level-ups, clue tier, coll progress…)
  dedupKey: string; // STABLE natural key (excludes receive time) for INSERT OR IGNORE
}

/** Longest string kept from a payload field: keeps embeds under Discord's caps and D1 rows small. */
export const MAX_FIELD = 100;
/** Most skills one LEVEL event can carry (there are 24); more is a malformed payload. */
const MAX_LEVELLED_SKILLS = 30;
/** LOOT events without a kill count dedup within this window (covers Dink's retries). */
export const LOOT_DEDUP_WINDOW_MS = 10 * 60_000;

function num(v: unknown): number | null {
  // Dink sends explicit nulls; Number(null) and Number("") are 0, which would
  // store a fake rarity or kc. Only numbers and numeric strings count.
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length ? v.trim().slice(0, MAX_FIELD) : null;
}

/**
 * Parse a Dink duration. KILL_COUNT sends ISO-8601 ("PT46M34S", "PT1M32.4S");
 * SPEEDRUN sends "m:ss.dd"; plain seconds are accepted too.
 */
export function parseDuration(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  const iso = t.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  }
  const m = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (m) return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return null;
}

/** Tiny stable string hash (djb2) — dedup fallback for types we don't special-case. */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

type Draft = Omit<DinkEvent, "dedupKey">;

/** Loot: sum the drop's value, surface the single most valuable item as headline. */
function fillLoot(ev: Draft, x: Record<string, any>): void {
  const items: any[] = Array.isArray(x.items) ? x.items : [];
  let total = 0;
  let best: any = null;
  let bestVal = -1;
  for (const it of items) {
    const q = num(it?.quantity) ?? 1;
    const each = num(it?.priceEach) ?? 0;
    const v = q * each;
    total += v;
    if (v > bestVal) {
      bestVal = v;
      best = it;
    }
  }
  ev.source = str(x.source);
  ev.value = num(x.totalValue) ?? total; // prefer Dink's own total when present
  ev.kc = num(x.killCount);
  ev.rarity = num(x.rarestProbability);
  if (best) {
    ev.item = str(best.name);
    ev.itemId = num(best.id);
    ev.quantity = num(best.quantity) ?? 1;
  }
}

/** Kill count: capture KC and, when this kill set a PB, the time in seconds. */
function fillKillCount(ev: Draft, x: Record<string, any>): void {
  ev.source = str(x.boss);
  ev.item = str(x.boss);
  ev.detail = str(x.boss);
  ev.kc = num(x.count);
  if (x.isPersonalBest === true) {
    ev.pbSeconds = parseDuration(x.time) ?? parseDuration(x.personalBest);
  }
}

function fillPet(ev: Draft, x: Record<string, any>): void {
  ev.item = str(x.petName); // Dink can't always name the pet; null is fine
  ev.source = str(x.source);
  ev.detail = str(x.milestone);
}

function fillCollection(ev: Draft, x: Record<string, any>): void {
  ev.item = str(x.itemName);
  ev.itemId = num(x.itemId);
  ev.value = num(x.price);
  ev.source = str(x.dropperName);
  ev.kc = num(x.dropperKillCount);
  const done = num(x.completedEntries);
  const total = num(x.totalEntries);
  if (done !== null && total !== null) ev.detail = `${done}/${total} collection log`;
}

function fillClue(ev: Draft, x: Record<string, any>): void {
  ev.source = str(x.clueType);
  ev.detail = str(x.clueType);
  ev.kc = num(x.numberCompleted);
  const items: any[] = Array.isArray(x.items) ? x.items : [];
  let total = 0;
  let best: any = null;
  let bestVal = -1;
  for (const it of items) {
    const v = (num(it?.quantity) ?? 1) * (num(it?.priceEach) ?? 0);
    total += v;
    if (v > bestVal) {
      bestVal = v;
      best = it;
    }
  }
  ev.value = total;
  if (best) {
    ev.item = str(best.name);
    ev.itemId = num(best.id);
    ev.quantity = num(best.quantity) ?? 1;
  }
}

function fillLevel(ev: Draft, x: Record<string, any>): void {
  const levelled: Record<string, any> =
    x.levelledSkills && typeof x.levelledSkills === "object" ? x.levelledSkills : {};
  const names = Object.keys(levelled).slice(0, MAX_LEVELLED_SKILLS);
  if (!names.length) return;
  ev.detail = names
    .map((s) => `${s.slice(0, 20)} ${num(levelled[s]) ?? "?"}`)
    .join(", ")
    .slice(0, MAX_FIELD);
  ev.item = names[0].slice(0, MAX_FIELD);
}

/**
 * Stable natural key per type (see file header). One exception: LOOT without a
 * kill count (Dink only sends killCount for NPC loot with RuneLite's Loot Tracker
 * on) has nothing that tells two identical drops apart, so it gets a receive-time
 * bucket. Retries inside the window still collapse; an identical drop in a later
 * window counts. A retry straddling a bucket edge can double-count once, which
 * beats silently dropping real loot.
 */
function dedupKeyFor(ev: Draft, raw: unknown, receivedAtMs: number): string {
  const p = canonicalRsn(ev.playerName);
  switch (ev.type) {
    case "LOOT": {
      const base = `${p}|LOOT|${ev.source ?? ""}|${ev.kc ?? ""}|${ev.itemId ?? ""}|${ev.value ?? ""}`;
      return ev.kc !== null ? base : `${base}|t${Math.floor(receivedAtMs / LOOT_DEDUP_WINDOW_MS)}`;
    }
    case "KILL_COUNT":
      return `${p}|KILL_COUNT|${ev.source ?? ""}|${ev.kc ?? ""}`;
    case "COLLECTION":
      return `${p}|COLLECTION|${ev.itemId ?? ev.item ?? ""}`;
    case "CLUE":
      return `${p}|CLUE|${ev.source ?? ""}|${ev.kc ?? ""}`;
    case "PET":
      return `${p}|PET|${ev.item ?? hashStr(JSON.stringify(raw ?? {}))}`;
    case "LEVEL":
      return `${p}|LEVEL|${ev.detail ?? ""}`;
    default:
      // Types we capture but don't specially parse: dedup exact retries by hash.
      return `${p}|${ev.type}|${hashStr(JSON.stringify(raw ?? {}))}`;
  }
}

/**
 * Normalize a raw Dink payload into a DinkEvent, or null if it isn't usable
 * (no player name, or no type). Unknown `type`s are still captured generically
 * so history accrues for features we haven't built yet.
 */
export function parseDinkEvent(d: any, receivedAtMs: number = Date.now()): DinkEvent | null {
  if (!d || typeof d !== "object") return null;
  const playerName = String(d.playerName ?? d.username ?? "").trim().slice(0, MAX_FIELD);
  if (!playerName) return null;
  const type = String(d.type ?? "").trim().toUpperCase();
  if (!type) return null;
  // Privacy gate: only store the public tier. Sensitive/opt-in types are dropped.
  if (!CAPTURED_TYPES.has(type)) return null;

  const extra: Record<string, any> = d.extra && typeof d.extra === "object" ? d.extra : {};
  const ev: Draft = {
    playerName,
    accountHash: str(d.dinkAccountHash) ?? str(d.accountHash),
    type,
    source: null,
    item: null,
    itemId: null,
    quantity: null,
    value: null,
    rarity: null,
    kc: null,
    pbSeconds: null,
    detail: null,
  };

  switch (type) {
    case "LOOT":
      fillLoot(ev, extra);
      break;
    case "KILL_COUNT":
      fillKillCount(ev, extra);
      break;
    case "PET":
      fillPet(ev, extra);
      break;
    case "COLLECTION":
      fillCollection(ev, extra);
      break;
    case "CLUE":
      fillClue(ev, extra);
      break;
    case "LEVEL":
      fillLevel(ev, extra);
      break;
    default:
      break; // generic capture — fields stay null, dedup by payload hash
  }

  return { ...ev, dedupKey: dedupKeyFor(ev, d, receivedAtMs) };
}

/**
 * Score a loot drop for the "biggest drop" highlight. Higher = more impressive.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  MAKE IT YOURS — same spirit as scorePlayer() in scoring.ts. Ships ranking │
 * │  by raw gp value (always present, most legible). Swap toward rarity (to    │
 * │  reward luck over gear) or a blend whenever you like — e.g.                │
 * │    return rarity ? value * (1 + Math.log10(1 / rarity)) : value;           │
 * │  Note: the store pre-filters candidates by value (topLootRowsSince), so if │
 * │  you weight heavily on rarity, widen that limit too.                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function dropScore(value: number, _rarity: number | null): number {
  return value;
}

/** Compact gp formatting: 1_234_567 -> "1.23M". Pure — unit-tested. */
export function formatGp(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return trimZeros((n / 1e9).toFixed(2)) + "B";
  if (abs >= 1e6) return trimZeros((n / 1e6).toFixed(2)) + "M";
  if (abs >= 1e3) return trimZeros((n / 1e3).toFixed(1)) + "K";
  return String(n);
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

/** Seconds -> "m:ss.dd" (92.4 -> "1:32.40"). Pure — unit-tested. */
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/**
 * The ephemeral `/dink setup` reply: the exact webhook line (key filled in) plus
 * the RuneLite steps, so a clanmate never copies the key by hand from a DM.
 * Pure so the URL shape is tested; the key is URI-encoded because it rides in a
 * query string and Dink sends the URL verbatim.
 */
export function dinkSetupMessage(origin: string, key: string, displayName: string): string {
  const webhook = `${origin}/dink?key=${encodeURIComponent(key)}`;
  return (
    `**Dink setup for ${displayName}** (only you can see this; don't share the link)\n\n` +
    "1. In RuneLite, open the wrench (Configuration). No Dink yet? Plugin Hub → search **Dink** → Install.\n" +
    "2. Open **Dink** settings and find **Primary Webhook URLs** (one URL per line).\n" +
    "3. Add this on a **new line**, keeping any Discord webhook already there:\n" +
    "```\n" + webhook + "\n```\n" +
    "4. Make sure the **Loot** and **Kill Count** notifiers are ticked " +
    "(Collection Log, Pet, Clue Scroll and Level are nice extras).\n\n" +
    "Test it: get a drop or kill a boss, then run `/loot` or `/pb`. " +
    "Deaths, trades and GE activity are discarded on arrival, never stored."
  );
}
