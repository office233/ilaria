import { NextResponse } from "next/server";
import { getOptionalSocialUserId, getAccountUserId } from "@/lib/social/session";
import { getOrCreateDmConversation, listConversations } from "@/lib/dm/repository";
import { dmDisabledResponse, dmErrorResponse, dmRateLimit, unauthorized } from "@/lib/dm/http";
import { DmConversationCreateSchema, parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

/** GET /api/dm/conversations — conversațiile utilizatorului curent. */
export async function GET(request: Request) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) return unauthorized();
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit")) || 30;
    const cursor = url.searchParams.get("cursor");
    const conversations = await listConversations(userId, { limit, cursor });
    return NextResponse.json({ conversations });
  } catch (err: unknown) {
    return dmErrorResponse(err, "list conversations");
  }
}

/** POST /api/dm/conversations { peer_user_id } — găsește sau creează DM-ul. */
export async function POST(request: Request) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    // Cont real obligatoriu: anonimii nu pot scrie DM / apela (audit messenger P0).
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const limited = await dmRateLimit(request, "dmConversation", userId);
    if (limited) return limited;

    const rawBody = await request.json().catch(() => ({}));
    const parsed = parseBody(DmConversationCreateSchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });
    }
    const peerId = parsed.data.peer_user_id;
    if (peerId === userId) {
      return NextResponse.json({ error: "Cannot DM yourself" }, { status: 400 });
    }
    const { conversationId, isNew } = await getOrCreateDmConversation(userId, peerId);
    return NextResponse.json({ conversation_id: conversationId, is_new: isNew });
  } catch (err: unknown) {
    return dmErrorResponse(err, "create conversation");
  }
}
