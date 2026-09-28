/**
 * GET /api/admin/go/drivers?status=pending|approved|suspended|rejected
 * Șoferii Go cu statusul de onboarding și documentele lor. Aprobarea /
 * suspendarea se fac prin PATCH /api/admin/fleet/[id] (auditat, emailuri,
 * trepte de comision); revizia documentelor prin ./[id]/documents.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const StatusSchema = z.enum(["pending", "approved", "suspended", "rejected"]).default("pending");

const FILTER: Record<z.infer<typeof StatusSchema>, string> = {
  pending: "c.verification_status IN ('pending', 'in_review')",
  approved: "c.verification_status = 'approved' AND c.active",
  suspended: "c.verification_status = 'approved' AND NOT c.active",
  rejected: "c.verification_status = 'rejected'",
};

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  const parsed = StatusSchema.safeParse(new URL(req.url).searchParams.get("status") ?? undefined);
  if (!parsed.success) return NextResponse.json({ error: "invalid_status" }, { status: 400 });

  const { rows } = await dbQuery(
    `SELECT c.id, c.full_name, c.phone, c.email, c.city, c.vehicle_type, c.vehicle_make, c.vehicle_model,
            c.vehicle_plate, c.verification_status, c.active, c.is_online, c.rating, c.user_id IS NOT NULL AS has_account,
            c.created_at::text,
            COALESCE((SELECT json_agg(json_build_object('doc_type', d.doc_type, 'status', d.status,
                                                        'expires_at', d.expires_at, 'file_url', d.file_url,
                                                        'has_file', d.file_key IS NOT NULL)
                                      ORDER BY d.doc_type)
                        FROM courier_documents d WHERE d.courier_id = c.id), '[]'::json) AS documents
       FROM couriers c
      WHERE c.kind = 'driver' AND c.deleted_at IS NULL AND ${FILTER[parsed.data]}
      ORDER BY c.created_at DESC
      LIMIT 200`,
  );
  return NextResponse.json({ drivers: rows });
}
