/**
 * POST /api/admin/food/orders/[id] — acțiuni de dispecerat pe o comandă Food:
 *   { action: "cancel", reason? } | { action: "reassign" } | { action: "delivered" }
 * Permisiunea `mobility`; auditat în admin_audit_log. Audit food-go #7.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { adminCancelFoodOrder, adminMarkFoodDelivered, adminReassignFoodOrder } from "@/lib/food/admin-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), reason: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("reassign") }),
  z.object({ action: z.literal("delivered") }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const body = parsed.data;

  const result =
    body.action === "cancel"
      ? await adminCancelFoodOrder(id, body.reason ?? null)
      : body.action === "reassign"
        ? await adminReassignFoodOrder(id)
        : await adminMarkFoodDelivered(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code });

  await logAdminAction({
    action: `food.order_${body.action}`,
    targetType: "local_order",
    targetId: id,
    details: body.action === "cancel" ? { reason: body.reason ?? null, refund_status: result.refund_status ?? null } : {},
    req,
    actor,
  });
  return NextResponse.json(result);
}
