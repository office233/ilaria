/**
 * Fixarea unui comentariu de către proprietarul clipului (cont real).
 *   PUT → fixează (înlocuiește fixarea anterioară)   DELETE → defixează
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { SOCIAL_LIMITS } from "@/lib/social/config";
import { CommentError, setPinned } from "@/lib/social/comments/mutations";
import { getAccountUserId } from "@/lib/social/session";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function mutate(ctx: Ctx, pinned: boolean) {
  try {
    const { id } = await ctx.params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const viewerId = await getAccountUserId();
    if (!viewerId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const rl = await rateLimit("comment_pin", viewerId, SOCIAL_LIMITS.pinPerUser);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    await setPinned(viewerId, id, pinned);
    return NextResponse.json({ pinned, id });
  } catch (error) {
    if (error instanceof CommentError) return NextResponse.json({ error: error.code }, { status: error.status });
    logger.error({ err: error }, "[comment pin] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export const PUT = (_req: Request, ctx: Ctx) => mutate(ctx, true);
export const DELETE = (_req: Request, ctx: Ctx) => mutate(ctx, false);
