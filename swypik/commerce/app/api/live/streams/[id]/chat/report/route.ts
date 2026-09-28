import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";
import { LIVE_CONFIG } from "@/lib/live/config";
import { LIVE_CHAT_REPORT_REASONS, reportLiveChatMessage } from "@/lib/live/chat-moderation";

export const dynamic = "force-dynamic";

const Schema = z.object({
  messageId: z.number().int().positive(),
  reason: z.enum(LIVE_CHAT_REPORT_REASONS).default("other"),
});

/** POST /api/live/streams/[id]/chat/report { messageId, reason } — raport către moderare (moderation_reports). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("liveChatModeration", session.userId, LIVE_CONFIG.rate.chatModerationUser);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(Schema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const res = await reportLiveChatMessage(id, parsed.data.messageId, session.userId, parsed.data.reason);
  if (!res.ok) return NextResponse.json({ error: res.code }, { status: res.code === "not_found" ? 404 : 422 });
  return NextResponse.json({ ok: true }, { status: 201 });
}
