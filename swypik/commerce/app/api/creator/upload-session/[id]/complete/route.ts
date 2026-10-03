import { NextResponse } from "next/server";
import { completeUploadSession } from "@/lib/video/upload/complete-session";
import { errorResponse, guardAuthor, jsonError, readJson, validId } from "@/lib/video/upload/http";
import { CompleteUploadSchema } from "@/lib/video/upload/schemas";

export const dynamic = "force-dynamic";

/**
 * Închide uploadul și pornește procesarea (idempotent). Body opțional:
 * `{ trim: { startMs, endMs } }` — tăierea aleasă în pasul „Editare”.
 * 503 `queue_unavailable`: fișierul e salvat, dar coada nu a răspuns —
 * clientul reîncearcă același apel.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await guardAuthor("uploadSession");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  const body = await readJson(req, CompleteUploadSchema);
  if (!body.ok) return body.response;
  try {
    const trim = { startMs: body.data.trim?.startMs ?? null, endMs: body.data.trim?.endMs ?? null };
    return NextResponse.json(await completeUploadSession(id, guard.author.userId, trim));
  } catch (err) {
    return errorResponse(err, "complete");
  }
}
