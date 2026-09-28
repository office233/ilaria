import { NextResponse } from "next/server";
import { z } from "zod";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { searchUsers } from "@/lib/users/search";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  q: z.string().trim().min(2, "q too short").max(40, "q too long"),
});

/**
 * GET /api/users/search?q=... — directory search for the messenger
 * "add contact" flow. Auth required. Returns only id/username/display_name/
 * avatar — never email or phone. Excludes the caller themselves.
 */
export async function GET(request: Request) {
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("usersSearch", userId, { limit: 30, window: 60 });
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({ q: url.searchParams.get("q") ?? "" });
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query", users: [] },
        { status: 400 },
      );
    }

    const users = await searchUsers(userId, parsed.data.q);
    return NextResponse.json({ users });
  } catch (err: unknown) {
    logger.error({ err }, "[users/search] failed");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
