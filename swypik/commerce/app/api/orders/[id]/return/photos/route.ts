/**
 * Customer Return Evidence Photos Upload API
 * POST /api/orders/[id]/return/photos
 *
 * Multipart form upload (field name: file). Authenticated via the
 * order_lookup_token passed in the 'token' form field. Uploads to S3/R2
 * under returns/<orderId>/. Returns { ok, url, key, size }.
 *
 * Note: photos are persisted on the return request itself (in
 * commerce_orders.metadata.return_evidence_urls) via the main
 * POST /api/orders/[id]/return route; this endpoint is the staging step
 * that returns URLs the client can include in the return submission.
 *
 * Constraints:
 *   - Max 4 photos per order (enforced both here and at submission time)
 *   - Reuses lib/storage/upload.ts which already validates MIME, size,
 *     and image signature (max 5 MB, JPEG/PNG/WebP/AVIF/GIF)
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { uploadFile, isStorageConfigured } from "@/lib/storage/upload";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PHOTOS = 4;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled("returns")) return frozenResponse("returns");
  const { id } = await params;

  const rl = await rateLimit("orderReturnPhotos", `${getClientIP(req)}:${id}`);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  if (!isStorageConfigured()) {
    return NextResponse.json(
      { error: "storage_unavailable" },
      { status: 503 }
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400 }
    );
  }

  const token = String(formData.get("token") || "");
  const file = formData.get("file");

  if (!token) {
    return NextResponse.json({ error: "token_missing" }, { status: 401 });
  }
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "file_missing" }, { status: 400 });
  }

  const { rows } = await dbQuery<{ id: string; metadata: Record<string, unknown> }>(
    `SELECT id, metadata
       FROM commerce_orders
      WHERE id = $1::uuid
        AND metadata->>'order_lookup_token' = $2
      LIMIT 1`,
    [id, token]
  );
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "order_not_found" },
      { status: 404 }
    );
  }

  const meta = rows[0].metadata || {};
  const returnEvidence = (meta as { return_evidence_urls?: unknown }).return_evidence_urls;
  const evidence = Array.isArray(returnEvidence) ? returnEvidence : [];
  if (evidence.length >= MAX_PHOTOS) {
    return NextResponse.json(
      { error: "photo_limit", max: MAX_PHOTOS },
      { status: 409 }
    );
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const mime = (file as File).type || "image/jpeg";
    const name = (file as File).name || "evidence";
    const result = await uploadFile(buf, name, mime, {
      keyPrefix: `returns/${id}`,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    logger.error({ err }, "[Return Photo Upload] failed");
    return NextResponse.json(
      { error: "upload_failed" },
      { status: 400 }
    );
  }
}
