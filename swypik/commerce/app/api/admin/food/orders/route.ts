/**
 * GET /api/admin/food/orders — comenzile Food active pentru consola /admin/go
 * (cele blocate primele). Permisiunea `mobility`.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { listActiveFoodOrders } from "@/lib/food/admin-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json({ orders: await listActiveFoodOrders() });
}
