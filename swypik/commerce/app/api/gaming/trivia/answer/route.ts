import { NextRequest, NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { dbQuery } from "@/lib/db";
import { awardXp } from "@/lib/gaming/xp";
import { TRIVIA_GAME_ID, XP_RULES, triviaXp } from "@/lib/gaming/config";
import { nextStreak, xpDay } from "@/lib/gaming/level-math";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/security/rate-limit";
import { verifyGamingToken, hashToken } from "@/lib/gaming/tokens";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { TriviaQuestion } from "@/lib/gaming/opentdb";

export const dynamic = "force-dynamic";

const AnswerPayloadSchema = z.object({
  roundToken: z.string().min(1).max(2000),
  answers: z.array(z.object({ questionId: z.string().min(1).max(100), answer: z.string().min(1).max(500) })).min(1).max(50),
});

/** Streak moves only on the first completed round of the day (see nextStreak). */
async function updateTriviaStreak(userId: string, today: string): Promise<number> {
  const { rows } = await dbQuery<{ last_day: string | null; streak: number | null }>(
    `SELECT to_char(last_trivia_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_day, trivia_streak_days AS streak
       FROM gaming_user_profiles WHERE user_id = $1`,
    [userId],
  );
  const streak = nextStreak(rows[0]?.last_day ?? null, today, Number(rows[0]?.streak ?? 0));
  await dbQuery(
    `INSERT INTO gaming_user_profiles (user_id, trivia_streak_days, last_trivia_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE
       SET trivia_streak_days = $2, last_trivia_at = now(), updated_at = now()`,
    [userId, streak],
  );
  return streak;
}

/**
 * POST /api/gaming/trivia/answer — the ONLY place a trivia score is
 * computed. The client submits its picked answers; this grades them against
 * gaming_trivia_rounds.questions (never sent before grading) using the
 * signed, single-use round token from GET /api/gaming/trivia.
 *
 * Daily trivia: every round is scored, but XP + streak are granted once per
 * UTC day (ledger ref = day), so replaying a known question set earns nothing.
 */
export async function POST(req: NextRequest) {
  if (!isEnabled("gaming")) return frozenResponse("gaming");

  try {
    // XP doar pentru conturi reale; vizitatorii nu creează rânduri `users` (audit G2).
    const userId = await getAccountUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("gamingTriviaAnswer", userId, { limit: 10, window: 60 });
    if (!rl.success) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    const parsed = AnswerPayloadSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
    }
    const { roundToken, answers } = parsed.data;

    const payload = verifyGamingToken(roundToken, "trivia");
    if (!payload || payload.userId !== userId) {
      return NextResponse.json({ ok: false, error: "invalid_round_token" }, { status: 400 });
    }

    // Atomically consume the round (single-use; expires_at is the DB-side backstop).
    const { rows } = await dbQuery<{ id: string; questions: TriviaQuestion[] }>(
      `UPDATE gaming_trivia_rounds
         SET used_at = now()
       WHERE token_hash = $1 AND user_id = $2 AND id = $3
         AND used_at IS NULL AND expires_at > now()
       RETURNING id, questions`,
      [hashToken(roundToken), userId, payload.ref],
    );
    const round = rows[0];
    if (!round) {
      return NextResponse.json({ ok: false, error: "round_token_reused_or_expired" }, { status: 400 });
    }

    const byId = new Map(round.questions.map((q) => [q.id, q]));
    let correctCount = 0;
    const results = answers.map(({ questionId, answer }) => {
      const q = byId.get(questionId);
      if (!q) return { questionId, correct: false, correctAnswer: null };
      const isCorrect = q.correctAnswer === answer;
      if (isCorrect) correctCount++;
      return { questionId, correct: isCorrect, correctAnswer: q.correctAnswer };
    });

    const score = correctCount * XP_RULES.trivia.pointsPerCorrect;
    await dbQuery(`UPDATE gaming_trivia_rounds SET score = $2 WHERE id = $1`, [round.id, score]);
    await dbQuery(
      `INSERT INTO gaming_scores (user_id, game_id, score, duration_ms, metadata) VALUES ($1, $2, $3, 0, $4)`,
      [userId, TRIVIA_GAME_ID, score, JSON.stringify({ roundId: round.id, correctCount, totalQuestions: round.questions.length })],
    );

    const today = xpDay();
    const award = await awardXp(userId, "trivia_daily", today, triviaXp(correctCount));
    const streakDays = award.duplicate ? null : await updateTriviaStreak(userId, today);

    return NextResponse.json({
      ok: true,
      score,
      correctCount,
      totalQuestions: round.questions.length,
      earnedXp: award.awarded,
      dailyXpAlreadyClaimed: award.duplicate,
      streakDays,
      results,
    });
  } catch (err) {
    logger.error({ err }, "[gaming.trivia.answer] failed");
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
