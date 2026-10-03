import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { checkSellerIntegrationSync } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const actor = await requireAdmin(req, "system");
  if (actor instanceof NextResponse) return actor;
  const result = await checkSellerIntegrationSync();
  return NextResponse.json(result, { status: result.status === "error" ? 503 : 200 });
}
