import { NextResponse } from "next/server";
import { getAccountUserId } from "@/lib/social/session";
import { getPeerUserId, requireParticipant, sendMessage } from "@/lib/dm/repository";
import { notifyNewDirectMessage } from "@/lib/dm/notify";
import { DM_ATTACHMENT_MIME, DM_CONFIG } from "@/lib/dm/config";
import { dmDisabledResponse, dmErrorResponse, dmRateLimit, unauthorized } from "@/lib/dm/http";
import { isStorageConfigured, uploadFile } from "@/lib/storage/upload";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/dm/conversations/[id]/attachments (multipart: file, caption?)
 * Urcă imaginea în storage-ul propriu (lib/storage/upload — verifică MIME,
 * semnătura binară, 5 MB) și trimite mesajul cu URL-ul generat de server.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const { id: conversationId } = await params;
    if (!isUuidParam(conversationId)) return invalidIdResponse();
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: "attachments_unavailable" }, { status: 503 });
    }
    const limited = await dmRateLimit(request, "dmAttachment", userId, DM_CONFIG.rate.attachment);
    if (limited) return limited;
    // Participantul se verifică ÎNAINTE de upload: nimic nu ajunge în bucket pentru străini.
    await requireParticipant(conversationId, userId);

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "file_required" }, { status: 400 });
    }
    if (!(DM_ATTACHMENT_MIME as readonly string[]).includes(file.type)) {
      return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
    }
    if (file.size > DM_CONFIG.attachmentMaxMb * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    const caption = String(form?.get("caption") ?? "").slice(0, DM_CONFIG.maxBody);

    let url: string;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const uploaded = await uploadFile(buffer, "attachment", file.type, { keyPrefix: `dm/${conversationId}` });
      url = uploaded.url;
    } catch (err) {
      logger.warn({ err, conversationId }, "[DM] attachment upload rejected");
      return NextResponse.json({ error: "invalid_file" }, { status: 400 });
    }

    const message = await sendMessage(userId, conversationId, { body: caption, mediaUrl: url });
    const peerId = await getPeerUserId(conversationId, userId).catch(() => null);
    if (peerId) {
      await notifyNewDirectMessage({
        recipientId: peerId,
        senderId: userId,
        conversationId,
        body: message.body,
        hasMedia: true,
      });
    }
    return NextResponse.json({ message });
  } catch (err: unknown) {
    return dmErrorResponse(err, "attachment");
  }
}
