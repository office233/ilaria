import { NextRequest, NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { dbQuery } from "@/lib/db";
import { awardXp } from "@/lib/gaming/xp";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/security/rate-limit";
import { verifyGamingToken, hashToken } from "@/lib/gaming/tokens";
import { arcadeXp, getGameCap } from "@/lib/gaming/config";
import { logger } from "@/lib/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ScorePayloadSchema = z.object({
  gameId: z.string().min(1).max(64),
  score: z.number().int().nonnegative(),
  sessionToken: z.string().min(1).max(2000),
});

/**
 * POST /api/gaming/score — arcade (non-trivia) score submissions.
 *
 * Trust boundary: the HTML5 game runs entirely client-side, so `score` is
 * always just a claim. What actually stops abuse:
 *  - sessionToken: signed by /api/gaming/session/start, single-use (DB row),
 *    bound to this user + gameId, so duration is measured server-side
 *    (now() - started_at), not from a client-supplied durationMs;
 *  - per-game plausible max score (lib/gaming/config.ts) — reject outliers;
 *  - per-game minimum duration — reject "instant" submissions;
 *  - daily XP cap per user, tracked in gaming_xp_daily.
 */
export async function POST(req: NextRequest) {
  if (!isEnabled("gaming")) return frozenResponse("gaming");

  try {
    // XP doar pentru conturi reale; vizitatorii nu mai creează rânduri `users` (audit G2).
    const userId = await getAccountUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("gamingScore", userId, { limit: 20, window: 60 });
    if (!rl.success) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const parsed = ScorePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
    }
    const { gameId, score, sessionToken } = parsed.data;

    const payload = verifyGamingToken(sessionToken, "session");
    if (!payload || payload.userId !== userId || payload.ref !== gameId) {
      return NextResponse.json({ ok: false, error: "invalid_session_token" }, { status: 400 });
    }

    // Atomically consume the session row (single-use).
    const tokenHash = hashToken(sessionToken);
    const { rows: sessionRows } = await dbQuery<{ id: string; started_at: string }>(
      `UPDATE gaming_game_sessions
         SET used_at = now()
       WHERE token_hash = $1 AND user_id = $2 AND game_id = $3
         AND used_at IS NULL AND expires_at > now()
       RETURNING id, started_at`,
      [tokenHash, userId, gameId],
    );
    const startedRow = sessionRows[0];
    if (!startedRow) {
      return NextResponse.json({ ok: false, error: "session_token_reused_or_expired" }, { status: 400 });
    }

    const durationMs = Date.now() - new Date(startedRow.started_at).getTime();
    const cap = getGameCap(gameId);

    if (durationMs < cap.minDurationMs) {
      logger.warn({ userId, gameId, durationMs }, "[gaming.score] submission too fast, rejected");
      return NextResponse.json({ ok: false, error: "too_fast" }, { status: 400 });
    }
    if (score > cap.maxScore) {
      logger.warn({ userId, gameId, score }, "[gaming.score] score over plausible cap, rejected");
      return NextResponse.json({ ok: false, error: "score_over_cap" }, { status: 400 });
    }

    await dbQuery(
      `INSERT INTO gaming_scores (user_id, game_id, score, duration_ms) VALUES ($1, $2, $3, $4)`,
      [userId, gameId, score, durationMs],
    );

    // XP once per session (ledger ref = session id), bounded by the daily cap.
    const award = await awardXp(userId, "arcade_round", startedRow.id, arcadeXp(score));
    const earnedXp = award.awarded;

    return NextResponse.json({
      ok: true,
      score,
      earnedXp,
    });
  } catch (err) {
    logger.error({ err }, "[gaming.score] failed");
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
