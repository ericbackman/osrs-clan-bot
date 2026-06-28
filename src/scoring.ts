// Leaderboard scoring — how the bot ranks gains. The domain types live here
// because both the store (produces gains) and index (renders them) need them.

export interface SkillGain {
  skill: string;
  xpGained: number;
  levelsGained: number;
  beforeXp: number;
  afterXp: number;
  beforeLevel: number;
  afterLevel: number;
}

export interface PlayerGains {
  rsn: string;
  displayName: string;
  discordUserId: string | null;
  skillGains: SkillGain[];
}

export interface RankedPlayer {
  rsn: string;
  displayName: string;
  discordUserId: string | null;
  score: number;
  xpGained: number;
  rank: number;
}

/**
 * Score one player's window of gains. Higher = better. rankGains() sorts on this.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  MAKE IT YOURS — same decision as score_player in                          │
 * │  data_explorer/osrs/scoring.py. The bot ships with the raw-XP baseline so  │
 * │  it works today; swap in your metric whenever you like.                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 * Ideas: weight by levels gained (flatters newer accounts), use WOM EHP gained
 * (effort-fair), or add a DIVERSITY bonus — reward training many skills over
 * grinding one, which is exactly the "don't just do one thing" spirit you wanted.
 * Whatever you choose, keep it MONOTONIC: more XP in a skill must never lower the
 * score (the test in test/scoring.test.ts checks this).
 */
export function scorePlayer(skillGains: SkillGain[]): number {
  return skillGains.reduce((total, g) => total + g.xpGained, 0);
}

/** Rank players best-first. Ties share the lower place (1, 2, 2, 4). */
export function rankGains(players: PlayerGains[]): RankedPlayer[] {
  const scored = players.map((p) => ({
    rsn: p.rsn,
    displayName: p.displayName,
    discordUserId: p.discordUserId,
    score: scorePlayer(p.skillGains),
    xpGained: p.skillGains.reduce((a, g) => a + g.xpGained, 0),
  }));
  scored.sort((a, b) => b.score - a.score);

  const ranked: RankedPlayer[] = [];
  scored.forEach((row, i) => {
    const rank =
      i > 0 && row.score === ranked[i - 1].score ? ranked[i - 1].rank : i + 1;
    ranked.push({ ...row, rank });
  });
  return ranked;
}
