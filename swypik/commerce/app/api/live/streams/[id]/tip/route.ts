import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { isUuid } from "@/lib/validation/uuid";
import { LIVE_CONFIG } from "@/lib/live/config";
import { LiveTipError, sendLiveTip } from "@/lib/live/tips";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  amountCents: z.number().int(),
  idempotencyKey: z.string().uuid(),
}).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = await rateLimit("liveTip", session.userId, LIVE_CONFIG.rate.tipUser);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (
    parsed.data.amountCents < LIVE_CONFIG.tipMinCents ||
    parsed.data.amountCents > LIVE_CONFIG.tipMaxCents
  ) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  try {
    const result = await sendLiveTip({
      streamId: id,
      senderUserId: session.userId,
      amountCents: parsed.data.amountCents,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      alreadyApplied: result.alreadyApplied,
      tip: result.tip,
      balanceAfterCents: result.balanceAfterCents,
    });
  } catch (error) {
    if (error instanceof LiveTipError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    logger.error({ err: error, streamId: id, userId: session.userId }, "[live/tip] failed");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
