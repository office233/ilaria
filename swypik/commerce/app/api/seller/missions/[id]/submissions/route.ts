/**
 * GET /api/seller/missions/[id]/submissions — clipurile înscrise la misiunea
 * proprie (pentru jurizare). → { submissions: ManagedSubmission[] }
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { UUID } from "@/lib/missions/schemas";
import { listMissionSubmissions } from "@/lib/missions/manage";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["seller"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.sellerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const submissions = await listMissionSubmissions(id, { sellerId: auth.sellerId });
  if (!submissions) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ submissions });
}
