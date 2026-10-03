import { NextResponse } from "next/server";
import { getOptionalSocialUserId, getAccountUserId } from "@/lib/social/session";
import { listMessages, sendMessage, getPeerUserId } from "@/lib/dm/repository";
import { notifyNewDirectMessage } from "@/lib/dm/notify";
import { dmDisabledResponse, dmErrorResponse, dmRateLimit, unauthorized } from "@/lib/dm/http";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { DmMessageCreateSchema, parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/dm/conversations/[id]/messages?before=&limit= */
export async function GET(request: Request, { params }: Ctx) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) return unauthorized();
    const { id: conversationId } = await params;
    if (!isUuidParam(conversationId)) return invalidIdResponse();
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit")) || undefined;
    const before = url.searchParams.get("before");
    const messages = await listMessages(conversationId, userId, {
      limit,
      beforeCursor: before && !Number.isNaN(Date.parse(before)) ? before : null,
    });
    return NextResponse.json({ messages });
  } catch (err: unknown) {
    return dmErrorResponse(err, "list messages");
  }
}

/**
 * POST /api/dm/conversations/[id]/messages { body, reply_to_message_id? }
 * Imaginile trec prin …/attachments (URL-ul e generat de server, niciodată din client).
 */
export async function POST(request: Request, { params }: Ctx) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    // Cont real obligatoriu: anonimii nu pot scrie DM / apela (audit messenger P0).
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const { id: conversationId } = await params;
    if (!isUuidParam(conversationId)) return invalidIdResponse();
    const limited = await dmRateLimit(request, "dmMessage", userId);
    if (limited) return limited;

    const rawBody = await request.json().catch(() => ({}));
    const parsed = parseBody(DmMessageCreateSchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });
    }
    const message = await sendMessage(userId, conversationId, {
      body: parsed.data.body,
      replyToMessageId: parsed.data.reply_to_message_id ?? null,
    });

    const peerId = await getPeerUserId(conversationId, userId).catch(() => null);
    if (peerId) {
      await notifyNewDirectMessage({
        recipientId: peerId,
        senderId: userId,
        conversationId,
        body: message.body,
        hasMedia: false,
      });
    }
    return NextResponse.json({ message });
  } catch (err: unknown) {
    return dmErrorResponse(err, "send message");
  }
}
