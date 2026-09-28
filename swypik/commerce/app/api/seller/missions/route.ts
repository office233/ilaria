/**
 * Seller — misiunile proprii.
 *   GET  /api/seller/missions            → { missions: ManagedMission[] }
 *   POST /api/seller/missions  (draft)   → { id, slug }
 *        body: { title, brief, formatHint?, productId?, prizeCents, maxWinners, durationDays }
 * Misiunea devine publică doar după finanțare (POST /api/seller/missions/[id]/fund).
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { missionCreateSchema } from "@/lib/missions/schemas";
import { createMission } from "@/lib/missions/funding";
import { listManagedMissions } from "@/lib/missions/manage";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req, ["seller"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.sellerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const missions = await listManagedMissions({ sellerId: auth.sellerId });
  return NextResponse.json({ missions });
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, ["seller"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.sellerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rl = await rateLimit("seller-mission-create", auth.sellerId, { limit: 10, window: 3600 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(missionCreateSchema(), await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ error: "invalid_body", code: parsed.code, issues: parsed.issues }, { status: 400 });
  }

  const { rows: seller } = await dbQuery<{ status: string; user_id: string | null }>(
    `SELECT status, user_id FROM sellers WHERE id = $1`,
    [auth.sellerId],
  );
  if (!seller[0] || !["approved", "active"].includes(seller[0].status)) {
    return NextResponse.json({ error: "seller_not_active" }, { status: 403 });
  }

  if (parsed.data.productId) {
    const { rows: product } = await dbQuery(
      `SELECT 1 FROM marketplace_products WHERE id = $1 AND seller_id = $2`,
      [parsed.data.productId, auth.sellerId],
    );
    if (!product[0]) return NextResponse.json({ error: "product_not_owned" }, { status: 403 });
  }

  try {
    const created = await createMission(parsed.data, {
      kind: "seller",
      sellerId: auth.sellerId,
      userId: seller[0].user_id ?? auth.userId,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    logger.error({ err, sellerId: auth.sellerId }, "[seller/missions] create failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
