import { NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { publishTyping } from "@/lib/dm/repository";
import { DM_CONFIG } from "@/lib/dm/config";
import { dmDisabledResponse, dmErrorResponse, unauthorized } from "@/lib/dm/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

/** POST /api/dm/conversations/[id]/typing — semnal efemer „scrie…” (Redis, fără DB). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const rl = await rateLimit("dmTyping", userId, DM_CONFIG.rate.typing);
    // Prea des: ignorăm semnalul fără eroare (e doar cosmetic).
    if (!rl.success) return NextResponse.json({ ok: false }, { status: 202 });
    await publishTyping(id, userId);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    return dmErrorResponse(err, "typing");
  }
}
