/**
 * Blocare utilizator — doar conturi reale.
 *   GET → { blocked_by_me, blocks_me }   PUT → blochează   DELETE → deblochează
 * Blocarea șterge follow-urile în ambele sensuri (lib/social/blocks.ts).
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { blockUser, getBlockState, unblockUser } from "@/lib/social/blocks";
import { SOCIAL_LIMITS } from "@/lib/social/config";
import { getAccountUserId } from "@/lib/social/session";
import { dbQuery } from "@/lib/db";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function resolve(ctx: Ctx): Promise<{ viewerId: string; targetId: string } | NextResponse> {
  const { id } = await ctx.params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const viewerId = await getAccountUserId();
  if (!viewerId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (viewerId === id) return NextResponse.json({ error: "cannot_block_self" }, { status: 400 });
  return { viewerId, targetId: id };
}

export async function GET(_req: Request, ctx: Ctx) {
  const r = await resolve(ctx);
  if (r instanceof NextResponse) return r;
  const state = await getBlockState(r.viewerId, r.targetId);
  return NextResponse.json({ blocked_by_me: state.blockedByMe, blocks_me: state.blocksMe });
}

async function mutate(ctx: Ctx, block: boolean) {
  try {
    const r = await resolve(ctx);
    if (r instanceof NextResponse) return r;
    const rl = await rateLimit("user_block", r.viewerId, SOCIAL_LIMITS.blockPerUser);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    if (block) {
      const { rows } = await dbQuery(`SELECT 1 FROM users WHERE id = $1`, [r.targetId]);
      if (rows.length === 0) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
      await blockUser(r.viewerId, r.targetId);
    } else {
      await unblockUser(r.viewerId, r.targetId);
    }
    return NextResponse.json({ blocked_by_me: block });
  } catch (error) {
    logger.error({ err: error }, "[block] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export const PUT = (_req: Request, ctx: Ctx) => mutate(ctx, true);
export const DELETE = (_req: Request, ctx: Ctx) => mutate(ctx, false);
