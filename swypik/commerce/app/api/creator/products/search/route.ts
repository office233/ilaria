import { NextResponse } from "next/server";
import { searchTaggableProducts } from "@/lib/video/product-eligibility";
import { errorResponse, guardAuthor } from "@/lib/video/upload/http";

export const dynamic = "force-dynamic";

const MAX_RESULTS = 8;

/**
 * GET /api/creator/products/search?q= — produse care pot fi etichetate pe un
 * clip: doar cele eligibile pentru feed (altfel eticheta ar ascunde clipul).
 */
export async function GET(req: Request) {
  const guard = await guardAuthor("uploadParts");
  if (!guard.ok) return guard.response;
  const q = new URL(req.url).searchParams.get("q") || "";
  try {
    const products = await searchTaggableProducts(q, MAX_RESULTS);
    return NextResponse.json({ products }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "product search");
  }
}
