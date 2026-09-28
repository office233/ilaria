import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const locale = url.searchParams.get("locale") || "ro";
    const { getCategoryHierarchy } = await import("@/lib/db/product-queries");
    const hierarchy = await getCategoryHierarchy(locale);
    return applyCachePolicy(NextResponse.json({ hierarchy }), "categories", req);
  } catch (e: any) {
    logger.error({ err: e }, "[Categories API]");
    return NextResponse.json({ error: "err", hierarchy: [] }, { status: 500 });
  }
}
