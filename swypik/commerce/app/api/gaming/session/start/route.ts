import { NextRequest, NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { dbQuery } from "@/lib/db";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { issueGamingToken, hashToken } from "@/lib/gaming/tokens";
import { SESSION_TOKEN_TTL_SECONDS } from "@/lib/gaming/config";
import { logger } from "@/lib/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";

const StartPayloadSchema = z.object({
  gameId: z.string().min(1).max(64),
});

/**
 * POST /api/gaming/session/start — issues a signed, single-use token that
 * proves a game actually started server-side. /api/gaming/score requires
 * this token so duration can be measured from started_at -> now() instead
 * of trusting a client-supplied durationMs.
 */
export async function POST(req: NextRequest) {
  if (!isEnabled("gaming")) return frozenResponse("gaming");

  try {
    // XP doar pentru conturi reale; vizitatorii nu mai creează rânduri `users` (audit G2).
    const userId = await getAccountUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("gamingSessionStart", userId || getClientIP(req), { limit: 30, window: 60 });
    if (!rl.success) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const parsed = StartPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
    }
    const { gameId } = parsed.data;

    const { rows } = await dbQuery<{ id: string }>(
      `SELECT id FROM gaming_games WHERE id = $1 AND is_active = true`,
      [gameId],
    );
    if (!rows[0]) {
      return NextResponse.json({ ok: false, error: "unknown_game" }, { status: 404 });
    }

    const token = issueGamingToken("session", userId, gameId, SESSION_TOKEN_TTL_SECONDS);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_SECONDS * 1000);

    await dbQuery(
      `INSERT INTO gaming_game_sessions (user_id, game_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, gameId, tokenHash, expiresAt.toISOString()],
    );

    return NextResponse.json({ ok: true, sessionToken: token, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    logger.error({ err }, "[gaming.session.start] failed");
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
