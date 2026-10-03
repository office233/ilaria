/** Helpers comuni pentru rutele /api/dm/* (flag, erori, rate limit dublu). */
import { NextResponse } from "next/server";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import { ABUSE_LIMITS } from "@/lib/security/abuse-limits";
import { getClientIP, rateLimit, type RateLimitConfig } from "@/lib/security/rate-limit";
import { isStatusError } from "./types";

/** Răspunsul 410 când Messenger e oprit, altfel null. */
export function dmDisabledResponse(): Response | null {
  return !isEnabled("dm") && !isEnabled("messenger") ? frozenResponse("dm") : null;
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Limită per utilizator + limită per IP (anti-abuz). Întoarce 429 sau null. */
export async function dmRateLimit(
  request: Request,
  key: string,
  userId: string,
  config?: RateLimitConfig,
): Promise<NextResponse | null> {
  const rl = await rateLimit(key, userId, config);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const ipRl = await rateLimit("dm_ip", getClientIP(request), ABUSE_LIMITS.dmPerIp);
  if (!ipRl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return null;
}

/** 4xx din modulele DM → JSON cu `code`; restul → 500 logat. */
export function dmErrorResponse(err: unknown, tag: string): NextResponse {
  if (isStatusError(err) && err.status && err.status < 500) {
    return NextResponse.json({ error: err.code ?? err.message }, { status: err.status });
  }
  logger.error({ err }, `[DM] ${tag}`);
  return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}
