/**
 * POST /api/admin/merchant-claims/[id]  { action: "approve" | "reject", note? }
 *
 * Aprobarea leagă sellerul proprietarului de restaurant și îl face comandabil
 * (listing_mode = 'orderable'); vezi lib/food/claims.ts. Acțiune auditată.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { approveClaim, rejectClaim } from "@/lib/food/claims";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ReviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "partners");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
  }
  try {
    const parsed = parseBody(ReviewSchema, await req.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
    }
    const note = parsed.data.note || null;

    if (parsed.data.action === "reject") {
      const r = await rejectClaim(id, note);
      if (!r.ok) return NextResponse.json({ success: false, error: "not_found", code: "not_found" }, { status: 404 });
      await logAdminAction({ action: "merchant_claim.reject", targetType: "merchant_claim", targetId: id, details: { note }, req, actor });
      return NextResponse.json({ success: true });
    }

    const r = await approveClaim(id, note);
    if (!r.ok) {
      const status = r.code === "not_found" ? 404 : 409;
      return NextResponse.json({ success: false, error: r.code, code: r.code }, { status });
    }
    await logAdminAction({
      action: "merchant_claim.approve",
      targetType: "merchant_claim",
      targetId: id,
      details: { merchant_id: r.merchantId, seller_id: r.sellerId, created_seller: r.createdSeller },
      req,
      actor,
    });
    return NextResponse.json({ success: true, seller_id: r.sellerId, merchant_id: r.merchantId, created_seller: r.createdSeller });
  } catch (error: unknown) {
    logger.error({ err: error, id }, "[admin/merchant-claims] error");
    return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
  }
}
