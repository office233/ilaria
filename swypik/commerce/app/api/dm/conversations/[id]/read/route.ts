import { NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { markRead } from "@/lib/dm/repository";
import { dmDisabledResponse, dmErrorResponse, unauthorized } from "@/lib/dm/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

/** POST /api/dm/conversations/[id]/read — marchează citit + confirmare „Văzut” la interlocutor. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const { id: conversationId } = await params;
    if (!isUuidParam(conversationId)) return invalidIdResponse();
    const rl = await rateLimit("dmRead", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const result = await markRead(conversationId, userId);
    return NextResponse.json({ ok: true, last_read_at: result?.last_read_at ?? null });
  } catch (err: unknown) {
    return dmErrorResponse(err, "mark read");
  }
}
