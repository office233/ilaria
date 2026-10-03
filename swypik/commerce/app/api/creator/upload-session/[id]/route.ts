import { NextResponse } from "next/server";
import { abortUploadSession } from "@/lib/video/upload/abort-session";
import { errorResponse, guardAuthor, jsonError, validId } from "@/lib/video/upload/http";
import { loadStatusRow } from "@/lib/video/upload/session-repo";
import { toUploadStatus } from "@/lib/video/upload/status";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Starea reală a uploadului + procesării (etapă și procent scrise de worker). */
export async function GET(_req: Request, ctx: Ctx) {
  const guard = await guardAuthor("uploadParts");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  try {
    const row = await loadStatusRow(id, guard.author.userId);
    if (!row) return jsonError(404, "not_found");
    return NextResponse.json(toUploadStatus(row), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "status");
  }
}

/** Anulează uploadul (abort multipart + arhivează draftul). */
export async function DELETE(_req: Request, ctx: Ctx) {
  const guard = await guardAuthor("uploadSession");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  try {
    return NextResponse.json(await abortUploadSession(id, guard.author.userId));
  } catch (err) {
    return errorResponse(err, "abort");
  }
}
