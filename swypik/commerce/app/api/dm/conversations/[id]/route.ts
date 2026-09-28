import { NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { getConversationDetail } from "@/lib/dm/repository";
import { dmDisabledResponse, dmErrorResponse, unauthorized } from "@/lib/dm/http";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

/** GET /api/dm/conversations/[id] — interlocutor, „citit până la”, stare de blocare. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const conversation = await getConversationDetail(id, userId);
    return NextResponse.json({ conversation, viewer_id: userId });
  } catch (err: unknown) {
    return dmErrorResponse(err, "conversation detail");
  }
}
