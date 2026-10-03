/**
 * POST /api/admin/reviews/[id]/hide
 * Body: { reason?: string }
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam } from "@/lib/validation/params";
import { setReviewHidden } from "@/lib/admin/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireAdmin(req, "moderation");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  const result = await setReviewHidden({ reviewId: id, hidden: true, reason, actor });
  if (result.status === "not_found") {
    return NextResponse.json({ error: "review_not_found" }, { status: 404 });
  }
  if (result.status === "changed") {
    await logAdminAction({
      action: "review.hide",
      targetType: "product_review",
      targetId: id,
      details: { productId: result.productId, reason },
      req,
      actor,
    });
  }
  return NextResponse.json({ ok: true, action: "hide", unchanged: result.status === "unchanged" });
}
