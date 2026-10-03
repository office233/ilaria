import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccountUserId } from "@/lib/social/session";
import { blockUser, unblockUser, userExists } from "@/lib/dm/blocks";
import { DM_CONFIG } from "@/lib/dm/config";
import { dmDisabledResponse, dmErrorResponse, dmRateLimit, unauthorized } from "@/lib/dm/http";
import { parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

const BlockSchema = z.object({ user_id: z.string().uuid() });

async function handle(request: Request, action: "block" | "unblock") {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const limited = await dmRateLimit(request, "dmBlock", userId, DM_CONFIG.rate.block);
    if (limited) return limited;
    const parsed = parseBody(BlockSchema, await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });
    const target = parsed.data.user_id;
    if (target === userId) return NextResponse.json({ error: "cannot_block_self" }, { status: 400 });

    if (action === "block") {
      if (!(await userExists(target))) return NextResponse.json({ error: "not_found" }, { status: 404 });
      await blockUser(userId, target);
    } else {
      await unblockUser(userId, target);
    }
    return NextResponse.json({ ok: true, blocked: action === "block" });
  } catch (err: unknown) {
    return dmErrorResponse(err, action);
  }
}

/** POST /api/dm/blocks { user_id } — blochează (nu mai poate scrie și nu îi mai poți scrie). */
export async function POST(request: Request) {
  return handle(request, "block");
}

/** DELETE /api/dm/blocks { user_id } — deblochează. */
export async function DELETE(request: Request) {
  return handle(request, "unblock");
}
