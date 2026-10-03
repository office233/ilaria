/**
 * POST /api/auth/token/refresh
 * Header: Authorization: Bearer <token curent, încă valid>
 * → { success, access_token, expires_at }
 *
 * Rotire token: emite un token bearer nou (30 zile) și revocă imediat
 * tokenul vechi. Dacă tokenul e expirat/revocat → 401 (re-login).
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { ROTATE_BEARER_SQL } from "@/lib/auth/rotate-bearer";
import { hashSessionToken, isSessionTokenFormat } from "@/lib/auth/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  return isSessionTokenFormat(token) ? token : null;
}

export async function POST(req: Request) {
  try {
    const ip = getClientIP(req);
    const rl = await rateLimit("auth-token-refresh-ip", ip, { limit: 30, window: 300 });
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
    }

    const token = readBearer(req);
    if (!token) {
      return NextResponse.json({ success: false, error: "missing_token" }, { status: 401 });
    }

    const newToken = crypto.randomBytes(32).toString("hex");
    const userAgent = req.headers.get("user-agent")?.slice(0, 512) ?? null;
    const { rows } = await dbQuery<{ user_id: string; expires_at: string }>(
      ROTATE_BEARER_SQL,
      [hashSessionToken(token), hashSessionToken(newToken), userAgent, JSON.stringify({ via: "token_refresh", ip })],
    );
    const sess = rows[0];
    if (!sess) {
      return NextResponse.json({ success: false, error: "invalid_token" }, { status: 401 });
    }
    logger.info({ userId: sess.user_id }, "auth.token.refreshed");

    return NextResponse.json({
      success: true,
      access_token: newToken,
      expires_at: sess.expires_at,
    }, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
  } catch (err) {
    logger.error({ error: (err as Error).message }, "auth.token.refresh.error");
    return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
  }
}
