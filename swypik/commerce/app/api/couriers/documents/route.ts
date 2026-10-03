/**
 * POST /api/couriers/documents — șoferul/curierul logat își încarcă un document
 * (multipart/form-data: `doc_type`, `file` = poză JPEG/PNG/WebP/AVIF ≤ 5 MB,
 * `expires_at` opțional YYYY-MM-DD). Audit food-go #3: înainte nu exista upload,
 * iar PATCH scria doar jsonb-ul vechi, deci adminul revizuia fără fișier.
 *
 * Fișierul merge în storage-ul existent (R2, lib/storage/upload) sub
 * `courier-docs/<courierId>/`; în DB păstrăm doar cheia (file_key). Adminul îl
 * vede prin GET /api/admin/go/drivers/[id]/documents/file (permisiunea mobility).
 * Documentul revine în 'pending' până la revizia din /admin/go.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { isStorageConfigured, uploadFile } from "@/lib/storage/upload";
import { logger } from "@/lib/logger";
import { DRIVER_DOCUMENT_TYPES } from "@/lib/rides/settings-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UPLOAD_LIMIT = { limit: 20, window: 3600 };

const FieldsSchema = z.object({
  doc_type: z.enum(DRIVER_DOCUMENT_TYPES),
  expires_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function POST(req: Request) {
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("courierDocUpload", session.userId, UPLOAD_LIMIT);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  if (!isStorageConfigured()) return NextResponse.json({ error: "storage_unavailable" }, { status: 503 });

  const { rows: couriers } = await dbQuery<{ id: string }>(
    `SELECT id FROM couriers WHERE user_id = $1 AND deleted_at IS NULL`,
    [session.userId],
  );
  const courier = couriers[0];
  if (!courier) return NextResponse.json({ error: "not_a_courier" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const fields = FieldsSchema.safeParse({
    doc_type: form?.get("doc_type") ?? undefined,
    expires_at: (form?.get("expires_at") as string | null) || undefined,
  });
  if (!fields.success || !(file instanceof File)) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { doc_type, expires_at } = fields.data;
  if (expires_at && Date.parse(`${expires_at}T23:59:59Z`) < Date.now()) {
    return NextResponse.json({ error: "document_expired" }, { status: 400 });
  }

  let key: string;
  try {
    const result = await uploadFile(Buffer.from(await file.arrayBuffer()), file.name || "document.jpg", file.type, {
      keyPrefix: `courier-docs/${courier.id}`,
    });
    key = result.key;
  } catch (err) {
    logger.warn({ err, courierId: courier.id }, "[couriers/documents] upload rejected");
    return NextResponse.json({ error: "invalid_file" }, { status: 400 });
  }

  await dbQuery(
    `INSERT INTO courier_documents (courier_id, doc_type, status, file_key, expires_at, submitted_at)
     VALUES ($1, $2, 'pending', $3, $4::date, now())
     ON CONFLICT (courier_id, doc_type) DO UPDATE
       SET status = 'pending', file_key = EXCLUDED.file_key, file_url = NULL,
           expires_at = EXCLUDED.expires_at, submitted_at = now(), reviewed_at = NULL, updated_at = now()`,
    [courier.id, doc_type, key, expires_at ?? null],
  );
  // Aplicație nouă: trece în verificare când a trimis primul document.
  await dbQuery(
    `UPDATE couriers SET verification_status = 'in_review', updated_at = now()
      WHERE id = $1 AND verification_status = 'pending'`,
    [courier.id],
  );
  logger.info({ courierId: courier.id, doc_type }, "[couriers/documents] uploaded");
  return NextResponse.json({ ok: true, doc_type, status: "pending" });
}
