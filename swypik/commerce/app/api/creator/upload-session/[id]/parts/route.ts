import { NextResponse } from "next/server";
import { listUploadedParts, signUploadParts } from "@/lib/video/storage-multipart";
import { errorResponse, guardAuthor, jsonError, readJson, validId } from "@/lib/video/upload/http";
import { SignPartsSchema } from "@/lib/video/upload/schemas";
import { loadSession, type UploadSessionRow } from "@/lib/video/upload/session-repo";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function openSession(id: string, userId: string): Promise<UploadSessionRow | NextResponse> {
  const session = await loadSession(id, userId);
  if (!session) return jsonError(404, "not_found");
  if (session.status !== "uploading" && session.status !== "created") return jsonError(409, "session_closed");
  if (new Date(session.expires_at).getTime() < Date.now()) return jsonError(410, "session_expired");
  if (!session.upload_id) return jsonError(409, "session_closed");
  return session;
}

/** Părțile deja urcate — clientul le sare la reluare. */
export async function GET(_req: Request, ctx: Ctx) {
  const guard = await guardAuthor("uploadParts");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  try {
    const session = await openSession(id, guard.author.userId);
    if (session instanceof NextResponse) return session;
    const parts = await listUploadedParts(session.object_key, session.upload_id as string);
    return NextResponse.json(
      {
        partSize: Number(session.part_size),
        totalParts: Number(session.total_parts),
        uploaded: parts.map((p) => ({ partNumber: p.partNumber, size: p.size })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "list parts");
  }
}

/** URL-uri presemnate (UploadPart) pentru un lot de părți. */
export async function POST(req: Request, ctx: Ctx) {
  const guard = await guardAuthor("uploadParts");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  const body = await readJson(req, SignPartsSchema);
  if (!body.ok) return body.response;
  try {
    const session = await openSession(id, guard.author.userId);
    if (session instanceof NextResponse) return session;
    const total = Number(session.total_parts || 1);
    const numbers = Array.from(new Set(body.data.partNumbers));
    if (numbers.some((n) => n > total)) return jsonError(400, "invalid_part_number");
    const urls = await signUploadParts(session.object_key, session.upload_id as string, numbers, {
      partSize: Number(session.part_size || 0),
      byteSize: Number(session.byte_size || 0),
    });
    return NextResponse.json({ parts: urls }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "sign parts");
  }
}
