import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";
import { isUuid } from "@/lib/validation/uuid";
import { LiveChatMessageSchema, parseBody } from "@/lib/validation/schemas";
import { LIVE_CONFIG } from "@/lib/live/config";
import { getLiveStream } from "@/lib/live/queries";
import { isBannedFromChat, screenLiveChatMessage } from "@/lib/live/chat-moderation";
import { listRecentChat, liveChatSseResponse, parseLastEventId, postLiveChatMessage } from "@/lib/live/chat-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/live/streams/[id]/chat { message } — mesaj în chatul unui stream live.
 * Ordinea: auth → rate limit → blocare de către gazdă → Azure Content Safety → insert + fan-out.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cfg = LIVE_CONFIG.rate.chatMessageUser;
  const rl = await rateLimit("chat", `live:${session.userId}`, cfg);
  if (!rl.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: cfg.window },
      { status: 429, headers: { "Retry-After": String(cfg.window) } },
    );
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = parseBody(LiveChatMessageSchema, rawBody);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });

  if (await isBannedFromChat(id, session.userId)) return NextResponse.json({ error: "chat_banned" }, { status: 403 });
  const screen = await screenLiveChatMessage(parsedBody.data.message);
  if (!screen.ok) {
    return NextResponse.json({ error: screen.code }, { status: screen.code === "message_blocked" ? 422 : 503 });
  }

  const row = await postLiveChatMessage(id, session.userId, parsedBody.data.message);
  // Stream inexistent sau care nu e live: 404 (înainte: FK error → 500).
  if (!row) return NextResponse.json({ error: "stream_not_live" }, { status: 404 });
  return NextResponse.json({ id: row.id, created_at: row.created_at });
}

/**
 * GET — SSE (realtime) sau listă JSON recentă. Doar pentru streamuri existente,
 * programate sau live (nu pentru orice UUID / streamuri încheiate), cu rate limit
 * per IP pe deschiderile SSE.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const url = new URL(req.url);
  const accept = req.headers.get("accept") || "";

  if (accept.includes("text/event-stream")) {
    const rl = await rateLimit("liveChatSse", getClientIP(req), LIVE_CONFIG.rate.chatSseIp);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const stream = await getLiveStream(id);
    if (!stream) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (stream.status !== "live" && stream.status !== "scheduled") {
      return NextResponse.json({ error: "stream_not_live" }, { status: 410 });
    }
    const lastEventId = parseLastEventId(req.headers.get("last-event-id") || url.searchParams.get("lastEventId"));
    return liveChatSseResponse(id, lastEventId, req.signal);
  }
  // Plain JSON list (recent)
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  return NextResponse.json({ items: await listRecentChat(id, limit) });
}
