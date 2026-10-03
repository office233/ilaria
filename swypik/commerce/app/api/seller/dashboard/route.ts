/** GET /api/seller/dashboard — cifrele dashboard-ului (lib/seller/dashboard.ts). */
import { NextResponse } from "next/server";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { getSellerDashboard } from "@/lib/seller/dashboard";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ success: true, ...(await getSellerDashboard(sellerId)) });
  } catch (err) {
    logger.error({ err }, "[seller/dashboard] GET failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
