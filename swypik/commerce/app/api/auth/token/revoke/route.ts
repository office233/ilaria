/**
 * POST /api/auth/token/revoke
 * Header: Authorization: Bearer <token>
 * → { success: true }  (idempotent — și dacă tokenul era deja revocat)
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { hashSessionToken, isSessionTokenFormat } from "@/lib/auth/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const ip = getClientIP(req);
    const rl = await rateLimit("auth-token-revoke-ip", ip, { limit: 30, window: 300 });
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
    }

    const auth = req.headers.get("authorization");
    const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
    if (!isSessionTokenFormat(token)) {
      return NextResponse.json({ success: false, error: "missing_token" }, { status: 401 });
    }

    const { rowCount } = await dbQuery(
      `UPDATE user_sessions SET revoked_at = now()
        WHERE session_token_hash = $1 AND kind = 'bearer' AND revoked_at IS NULL`,
      [hashSessionToken(token)],
    );

    logger.info({ revoked: rowCount }, "auth.token.revoked");
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ error: (err as Error).message }, "auth.token.revoke.error");
    return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
  }
}
