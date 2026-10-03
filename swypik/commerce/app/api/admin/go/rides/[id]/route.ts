/**
 * POST /api/admin/go/rides/[id] — acțiuni de dispatch pe o cursă (auditate):
 *   { action: "assign", courier_id }  atribuire / reatribuire manuală
 *   { action: "cancel", reason? }     anulare forțată (fără taxă, hold eliberat)
 *   { action: "waive_fee" }           iartă taxa de anulare datorată
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse, uuidParamSchema } from "@/lib/validation/params";
import { adminAssignRide, waiveCancelFee } from "@/lib/rides/admin-ops";
import { cancelRide } from "@/lib/rides/transitions";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), courier_id: uuidParamSchema }),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("waive_fee") }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const data = parsed.data;

  try {
    if (data.action === "assign") {
      const r = await adminAssignRide(id, data.courier_id);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.code });
      await logAdminAction({
        actor,
        action: r.previous_driver_id ? "go.ride_reassign" : "go.ride_assign",
        targetType: "ride",
        targetId: id,
        details: { courier_id: data.courier_id, previous_driver_id: r.previous_driver_id },
        req,
      });
      return NextResponse.json({ ok: true });
    }
    if (data.action === "cancel") {
      const r = await cancelRide({ rideId: id, actor: "admin", reason: data.reason ?? "admin_cancel" });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.code });
      await logAdminAction({
        actor,
        action: "go.ride_cancel",
        targetType: "ride",
        targetId: id,
        details: { reason: data.reason ?? null },
        req,
      });
      return NextResponse.json({ ok: true });
    }
    if (!(await waiveCancelFee(id))) return NextResponse.json({ error: "bad_state" }, { status: 409 });
    await logAdminAction({ actor, action: "go.cancel_fee_waive", targetType: "ride", targetId: id, req });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error({ err, rideId: id, action: data.action }, "[admin/go/rides] action failed");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
