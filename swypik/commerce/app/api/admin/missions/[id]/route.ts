/**
 * Admin — acțiuni pe o misiune.
 *   GET  /api/admin/missions/[id] → { submissions: ManagedSubmission[] }
 *   POST /api/admin/missions/[id] { action: 'close' | 'archive' }
 *     close   → închide + returnează restul din escrow (refund Stripe / eliberare buget platformă)
 *     archive → ascunde misiunea (doar după închidere sau dacă nu a fost finanțată)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { parseBody } from "@/lib/validation/schemas";
import { UUID } from "@/lib/missions/schemas";
import { closeMission } from "@/lib/missions/funding";
import { listMissionSubmissions } from "@/lib/missions/manage";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ActionSchema = z.object({ action: z.enum(["close", "archive"]) }).strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["admin"]);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const submissions = await listMissionSubmissions(id, {});
  if (!submissions) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ submissions });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["admin"]);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = parseBody(ActionSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: "invalid_body", code: parsed.code }, { status: 400 });

  try {
    if (parsed.data.action === "close") {
      const res = await closeMission(id, {});
      if (!res.ok) return NextResponse.json({ error: res.code }, { status: res.code === "not_found" ? 404 : 409 });
      await logAdminAction({ action: "mission.close", targetType: "creator_mission", targetId: id, details: { refundedCents: res.refundedCents }, req });
      return NextResponse.json({ ok: true, refundedCents: res.refundedCents });
    }

    // archive: doar misiuni fără bani blocați în escrow.
    const { rowCount } = await dbQuery(
      `UPDATE creator_missions SET status = 'archived'
        WHERE id = $1 AND status <> 'archived'
          AND (status = 'closed' OR funding_status IN ('unfunded', 'refunded'))`,
      [id],
    );
    if (!rowCount) return NextResponse.json({ error: "close_first" }, { status: 409 });
    await logAdminAction({ action: "mission.archive", targetType: "creator_mission", targetId: id, req });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error({ err, missionId: id }, "[admin/missions/:id] action failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
