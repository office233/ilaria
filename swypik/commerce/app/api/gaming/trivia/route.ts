import { NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { getDailyTriviaQuestions, triviaLanguage } from "@/lib/gaming/opentdb";
import { dbQuery } from "@/lib/db";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/security/rate-limit";
import { issueGamingToken, hashToken } from "@/lib/gaming/tokens";
import { TRIVIA_ROUND_TTL_SECONDS } from "@/lib/gaming/config";
import { xpDay } from "@/lib/gaming/level-math";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/trivia — issues a fresh, server-authoritative round.
 *
 * The correct answers are stored in gaming_trivia_rounds, never sent to the
 * client. The client gets sanitized questions + a signed, single-use round
 * token; POST /api/gaming/trivia/answer is the only place scoring happens.
 */
export async function GET(req: Request) {
  if (!isEnabled("gaming")) return frozenResponse("gaming");

  try {
    // XP doar pentru conturi reale; vizitatorii nu mai creează rânduri `users` (audit G2).
    const userId = await getAccountUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("gamingTriviaStart", userId, { limit: 10, window: 60 });
    if (!rl.success) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    // ?locale= din UI: RO are bancă proprie; celelalte limbi primesc întrebări în engleză (anunțat în UI).
    const locale = new URL(req.url).searchParams.get("locale");
    const language = triviaLanguage(locale);
    const questions = await getDailyTriviaQuestions(language);

    // token_hash is UNIQUE, so seed it with a throwaway unique placeholder
    // (the real hash needs the row's id first) and overwrite it below.
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO gaming_trivia_rounds (user_id, token_hash, questions, expires_at)
       VALUES ($1, encode(gen_random_bytes(32), 'hex'), $2, $3)
       RETURNING id`,
      [userId, JSON.stringify(questions), new Date(Date.now() + TRIVIA_ROUND_TTL_SECONDS * 1000).toISOString()],
    );
    const roundId = rows[0].id;

    const token = issueGamingToken("trivia", userId, roundId, TRIVIA_ROUND_TTL_SECONDS);
    const tokenHash = hashToken(token);
    await dbQuery(`UPDATE gaming_trivia_rounds SET token_hash = $1 WHERE id = $2`, [tokenHash, roundId]);

    // Daily trivia: XP only for the first completed round of the (UTC) day.
    const { rows: claimed } = await dbQuery<{ id: string }>(
      `SELECT id FROM gaming_xp_events WHERE user_id = $1 AND action = 'trivia_daily' AND ref = $2 LIMIT 1`,
      [userId, xpDay()],
    );

    const sanitized = questions.map(({ id, category, difficulty, question, options }) => ({
      id,
      category,
      difficulty,
      question,
      options,
    }));

    return NextResponse.json({
      ok: true,
      roundToken: token,
      questions: sanitized,
      xpAvailableToday: claimed.length === 0,
      language,
    });
  } catch (err) {
    logger.error({ err }, "[gaming.trivia] failed to issue round");
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
