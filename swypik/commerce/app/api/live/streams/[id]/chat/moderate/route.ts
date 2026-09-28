import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";
import { LIVE_CONFIG } from "@/lib/live/config";
import { banLiveChatAuthor, hideLiveChatMessage } from "@/lib/live/chat-moderation";

export const dynamic = "force-dynamic";

const Schema = z.object({
  messageId: z.number().int().positive(),
  action: z.enum(["hide", "ban"]),
});

/**
 * POST /api/live/streams/[id]/chat/moderate { messageId, action: hide|ban }
 * Doar gazda streamului (sau un admin). „ban” = autorul nu mai poate scrie pe
 * acest stream și mesajele lui sunt retrase din toți clienții.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("liveChatModeration", session.userId, LIVE_CONFIG.rate.chatModerationUser);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(Schema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const actor = { userId: session.userId, role: session.role ?? null };
  const res = parsed.data.action === "hide"
    ? await hideLiveChatMessage(id, parsed.data.messageId, actor)
    : await banLiveChatAuthor(id, parsed.data.messageId, actor);
  if (!res.ok) {
    const status = res.code === "forbidden" ? 403 : res.code === "not_found" ? 404 : 422;
    return NextResponse.json({ error: res.code }, { status });
  }
  return NextResponse.json({ ok: true, removedIds: res.removedIds });
}
