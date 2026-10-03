/**
 * Admin — misiuni.
 *   GET  /api/admin/missions?status=active → { missions: ManagedMission[] } (toate sellerii + platformă)
 *   POST /api/admin/missions → misiune finanțată de platformă (activă imediat)
 *        body: { title, brief, formatHint?, productId?, prizeCents, maxWinners, durationDays }
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { parseBody } from "@/lib/validation/schemas";
import { missionCreateSchema } from "@/lib/missions/schemas";
import { createMission } from "@/lib/missions/funding";
import { listManagedMissions } from "@/lib/missions/manage";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["draft", "active", "closed", "archived"]);

export async function GET(req: Request) {
  const auth = await requireAuth(req, ["admin"]);
  if (auth instanceof NextResponse) return auth;
  const status = new URL(req.url).searchParams.get("status");
  if (status && !STATUSES.has(status)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  const missions = await listManagedMissions({ status: status ?? undefined });
  return NextResponse.json({ missions });
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = parseBody(missionCreateSchema(), await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ error: "invalid_body", code: parsed.code, issues: parsed.issues }, { status: 400 });
  }
  try {
    const created = await createMission(parsed.data, { kind: "platform", userId: auth.userId });
    await logAdminAction({
      action: "mission.create_platform",
      targetType: "creator_mission",
      targetId: created.id,
      details: { prizeCents: parsed.data.prizeCents, maxWinners: parsed.data.maxWinners },
      req,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    logger.error({ err }, "[admin/missions] create failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
