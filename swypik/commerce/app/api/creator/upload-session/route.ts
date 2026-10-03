/**
 * /api/creator/upload-session — un singur flux de upload video (S3 multipart).
 *
 *   POST                     → pornește sesiunea (limite din lib/video/limits)
 *   GET                      → sesiunile neterminate ale userului (reluare)
 *   POST /[id]/parts         → URL-uri presemnate pentru părți
 *   GET  /[id]/parts         → părțile deja urcate (reluare)
 *   POST /[id]/complete      → verifică + închide multipart + pornește procesarea
 *   GET  /[id]               → stare reală (upload / procesare / eroare)
 *   DELETE /[id]             → anulează
 */
import { NextResponse } from "next/server";
import { isVideoStorageConfigured } from "@/lib/storage/video-storage";
import { createUploadSession } from "@/lib/video/upload/create-session";
import { errorResponse, guardAuthor, jsonError, readJson } from "@/lib/video/upload/http";
import { CreateUploadSessionSchema } from "@/lib/video/upload/schemas";
import { listOpenSessions } from "@/lib/video/upload/session-repo";
import { toUploadStatus } from "@/lib/video/upload/status";
import { VIDEO_LIMITS } from "@/lib/video/limits";
import { normalizeCreatorUploadInput } from "@/lib/video/upload-session";
import { assertMixableTrack } from "@/lib/video/sound-track";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = await guardAuthor("uploadSession");
  if (!guard.ok) return guard.response;
  if (!isVideoStorageConfigured()) return jsonError(503, "storage_unavailable");

  const body = await readJson(req, CreateUploadSessionSchema);
  if (!body.ok) return body.response;

  try {
    const input = normalizeCreatorUploadInput({ ...body.data, creatorId: guard.author.userId });
    // /upload?audio=<id>: doar piese existente, active și licențiate (422, nu FK → 500).
    await assertMixableTrack(input.audioTrackId);
    const session = await createUploadSession(input);
    return NextResponse.json(
      { ...session, limits: { maxBytes: VIDEO_LIMITS.maxBytes, maxDurationMs: VIDEO_LIMITS.maxDurationMs } },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "create session");
  }
}

export async function GET() {
  const guard = await guardAuthor();
  if (!guard.ok) return guard.response;
  try {
    const rows = await listOpenSessions(guard.author.userId);
    return NextResponse.json({ sessions: rows.map(toUploadStatus) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "list sessions");
  }
}
