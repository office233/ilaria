import { NextResponse } from "next/server";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { VIRAL_PRODUCTS } from "@/lib/seller/viral-catalog.seed";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET() {
  if (!isEnabled("viralCatalog")) return frozenResponse("viralCatalog");

  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ success: true, products: VIRAL_PRODUCTS });
});
