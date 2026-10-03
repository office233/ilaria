import { NextResponse } from "next/server";
import { loadOwnedVideo } from "@/lib/video/auth";
import { errorResponse, guardAuthor, jsonError, validId } from "@/lib/video/upload/http";
import { reprocessVideo } from "@/lib/video/upload/reprocess";

export const dynamic = "force-dynamic";

/** „Reîncearcă procesarea” pentru un clip eșuat (fără re-upload). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await guardAuthor("uploadSession");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  try {
    const owned = await loadOwnedVideo(id, guard.author);
    if (!owned) return jsonError(404, "not_found");
    if (owned === "forbidden") return jsonError(403, "forbidden");
    return NextResponse.json({ ok: true, ...(await reprocessVideo(id)) });
  } catch (err) {
    return errorResponse(err, "reprocess");
  }
}
