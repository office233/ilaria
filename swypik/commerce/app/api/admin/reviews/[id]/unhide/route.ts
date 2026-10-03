/**
 * POST /api/admin/reviews/[id]/unhide
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

  const result = await setReviewHidden({ reviewId: id, hidden: false, reason: null, actor });
  if (result.status === "not_found") {
    return NextResponse.json({ error: "review_not_found" }, { status: 404 });
  }
  if (result.status === "changed") {
    await logAdminAction({
      action: "review.unhide",
      targetType: "product_review",
      targetId: id,
      details: { productId: result.productId },
      req,
      actor,
    });
  }
  return NextResponse.json({ ok: true, action: "unhide", unchanged: result.status === "unchanged" });
}
