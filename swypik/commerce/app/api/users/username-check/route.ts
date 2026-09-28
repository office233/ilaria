/**
 * GET /api/users/username-check?username=… → { available, reason? }
 * Pentru validarea live din „Editează profilul". Propriul username/alias e liber.
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { SOCIAL_LIMITS } from "@/lib/social/config";
import { getAccountUserId } from "@/lib/social/session";
import { checkUsernameAvailable, normalizeUsername } from "@/lib/social/username";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const rl = await rateLimit("username_check", getClientIP(req), SOCIAL_LIMITS.usernameCheck);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const username = normalizeUsername(new URL(req.url).searchParams.get("username"));
    const userId = await getAccountUserId();
    const problem = await checkUsernameAvailable(username, userId);
    return NextResponse.json(problem ? { available: false, reason: problem } : { available: true });
  } catch (error) {
    logger.error({ err: error }, "[username-check] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
