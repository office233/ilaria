/**
 * PATCH /api/admin/go/drivers/[id]/documents — revizia unui document de șofer
 * { doc_type, status: approved|rejected|pending, expires_at?, notes? } (upsert, auditat).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { DRIVER_DOCUMENT_TYPES } from "@/lib/rides/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  doc_type: z.enum(DRIVER_DOCUMENT_TYPES),
  status: z.enum(["approved", "rejected", "pending"]),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(500).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const d = parsed.data;

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO courier_documents (courier_id, doc_type, status, expires_at, notes, reviewed_at)
     SELECT c.id, $2, $3, $4::date, $5, now() FROM couriers c WHERE c.id = $1
     ON CONFLICT (courier_id, doc_type) DO UPDATE
       SET status = EXCLUDED.status,
           expires_at = COALESCE(EXCLUDED.expires_at, courier_documents.expires_at),
           notes = COALESCE(EXCLUDED.notes, courier_documents.notes),
           reviewed_at = now(), updated_at = now()
     RETURNING id`,
    [id, d.doc_type, d.status, d.expires_at ?? null, d.notes ?? null],
  );
  if (!rows.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await logAdminAction({
        actor,
    action: "go.driver_document_review",
    targetType: "courier",
    targetId: id,
    details: { doc_type: d.doc_type, status: d.status, expires_at: d.expires_at ?? null },
    req,
  });
  return NextResponse.json({ ok: true });
}
