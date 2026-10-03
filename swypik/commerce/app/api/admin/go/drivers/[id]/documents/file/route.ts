/**
 * GET /api/admin/go/drivers/[id]/documents/file?doc_type= — fișierul unui
 * document de șofer/curier, citit din storage și servit DOAR adminilor cu
 * permisiunea `mobility` (fără cache public). Audit food-go #3.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { getS3Client, getStorageBucket } from "@/lib/storage/s3-client";
import { DRIVER_DOCUMENT_TYPES } from "@/lib/rides/settings-shared";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DocType = z.enum(DRIVER_DOCUMENT_TYPES);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const docType = DocType.safeParse(new URL(req.url).searchParams.get("doc_type"));
  if (!docType.success) return NextResponse.json({ error: "invalid_doc_type" }, { status: 400 });

  const { rows } = await dbQuery<{ file_key: string | null }>(
    `SELECT file_key FROM courier_documents WHERE courier_id = $1 AND doc_type = $2`,
    [id, docType.data],
  );
  const key = rows[0]?.file_key;
  if (!key || !key.startsWith(`courier-docs/${id}/`)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const obj = await getS3Client().send(new GetObjectCommand({ Bucket: getStorageBucket(), Key: key }));
    const body = obj.Body ? await obj.Body.transformToByteArray() : null;
    if (!body) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new Response(Buffer.from(body), {
      headers: {
        "Content-Type": obj.ContentType ?? "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    logger.warn({ err, courierId: id }, "[admin/go/documents/file] read failed");
    return NextResponse.json({ error: "storage_unavailable" }, { status: 503 });
  }
}
