/**
 * POST /api/admin/merchants/[id]/reject
 * Respinge o aplicație de comerciant local: status 'pending' → 'rejected'.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { logAdminAction } from "@/lib/security/admin-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireAdmin(req, "partners");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  try {
    const { rows } = await dbQuery(
      `UPDATE local_merchants
          SET status = 'rejected', updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, name`,
      [id],
    );
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: "not_found_or_processed" }, { status: 404 });
    }
    await logAdminAction({
      action: "merchant.reject",
      targetType: "local_merchant",
      targetId: id,
      req,
      actor,
    });
    return NextResponse.json({ success: true, merchant: rows[0] });
  } catch (error: unknown) {
    logger.error({ err: error, id }, "[admin/merchants/reject] error");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
