/**
 * Server-side plausibility limits per game. The HTML5 games run entirely in
 * the client's browser, so score/duration in a POST body is just a claim —
 * these caps are what actually stop a forged postMessage from paying out.
 */
export type GameCap = {
  /** Highest score we will accept as plausible for this game. */
  maxScore: number;
  /** Minimum real time (ms) the round must have taken, measured server-side
   *  from the signed session-start token, not from the client's durationMs. */
  minDurationMs: number;
};

export const GAME_CAPS: Record<string, GameCap> = {
  game_2048: { maxScore: 200_000, minDurationMs: 8_000 },
  game_flappy: { maxScore: 5_000, minDurationMs: 4_000 },
};

export const DEFAULT_GAME_CAP: GameCap = { maxScore: 10_000, minDurationMs: 5_000 };

export function getGameCap(gameId: string): GameCap {
  return GAME_CAPS[gameId] ?? DEFAULT_GAME_CAP;
}

/** Session-start token lifetime — long enough for a real play session. */
export const SESSION_TOKEN_TTL_SECONDS = 30 * 60;

/** Trivia round token lifetime, per spec (single-use, ~10 min). */
export const TRIVIA_ROUND_TTL_SECONDS = 10 * 60;

/** gaming_games.id of the system row trivia scores are recorded against (migration 20260926_0120). */
export const TRIVIA_GAME_ID = "trivia_daily";

/** Hard daily ceiling on XP from repeatable actions (arcade rounds, daily trivia, watching). */
export const DAILY_XP_CAP = 300;

/**
 * Every XP-granting action. `ref` in gaming_xp_events makes each one
 * idempotent: arcade = per game session, daily actions = per day,
 * milestones = once per account.
 */
export const XP_ACTIONS = ["arcade_round", "trivia_daily", "watch_daily", "first_upload", "first_purchase"] as const;
export type XpAction = (typeof XP_ACTIONS)[number];

/** Actions counted against DAILY_XP_CAP (milestones are not). */
export const DAILY_CAPPED_ACTIONS: ReadonlySet<XpAction> = new Set<XpAction>(["arcade_round", "trivia_daily", "watch_daily"]);

export const XP_RULES = {
  arcade: { base: 10, pointsPerXp: 50, maxPerRound: 100 },
  trivia: { perCorrect: 20, maxPerDay: 100, pointsPerCorrect: 50 },
  /** Daily XP once the account watched at least `minViews` videos that day. */
  watchDaily: { xp: 15, minViews: 5 },
  firstUpload: { xp: 100 },
  firstPurchase: { xp: 100 },
} as const;

/** XP for one arcade round (before the daily cap). */
export function arcadeXp(score: number): number {
  const { base, pointsPerXp, maxPerRound } = XP_RULES.arcade;
  return Math.min(maxPerRound, Math.floor(Math.max(0, score) / pointsPerXp) + base);
}

/** XP for a completed daily trivia round (before the daily cap). */
export function triviaXp(correctCount: number): number {
  const { perCorrect, maxPerDay } = XP_RULES.trivia;
  return Math.min(maxPerDay, Math.max(0, correctCount) * perCorrect);
}

/**
 * Level curve: reaching level L needs LEVEL_XP_BASE * (L-1)^2 total XP
 * (L2 = 100, L3 = 400, L4 = 900 …). Used only by lib/gaming/level-math.ts.
 */
export const LEVEL_XP_BASE = 100;
export const MAX_LEVEL = 100;
