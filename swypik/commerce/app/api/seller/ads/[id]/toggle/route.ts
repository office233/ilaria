import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

/** Comuta active <-> paused. Campaniile in asteptare sau incheiate nu se pot comuta de seller. */
export const PATCH = withErrorHandling(async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: adId } = await params;

  const { rows } = await dbQuery<{ id: string; status: string }>(
    `UPDATE seller_ads
        SET status = CASE status WHEN 'active' THEN 'paused' ELSE 'active' END,
            updated_at = now()
      WHERE id = $1 AND seller_id = $2 AND status IN ('active', 'paused')
      RETURNING id, status`,
    [adId, sellerId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ success: false, error: "not_found_or_not_toggleable" }, { status: 404 });
  }

  return NextResponse.json({ success: true, campaign: rows[0] });
});
