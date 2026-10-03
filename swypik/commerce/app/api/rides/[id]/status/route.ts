/**
 * PATCH /api/rides/[id]/status — mașină de stări STRICTĂ cu rol per tranziție.
 *
 *   driver:        accepted → arriving → in_progress → completed
 *   rider:         requested|searching|accepted|arriving → cancelled
 *   driver:        accepted|arriving → cancelled
 *     (taxa de anulare: lib/rides/policy + go_settings, încasată pe card)
 *
 * 'accepted' NU trece pe aici — o setează exclusiv dispatch engine (acceptOffer)
 * sau consola admin. Implementarea: lib/rides/transitions.ts.
 */
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { loadRide, resolveRole, canTransition } from "@/lib/rides/service";
import { advanceRide, cancelRide, completeRide, type TransitionResult } from "@/lib/rides/transitions";
import { RideStatusPatchSchema } from "@/lib/validation/rides";
import { parseBody } from "@/lib/validation/schemas";
import { sendMobilityPush } from "@/lib/dispatch/push-i18n";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "rides/status" });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("rideAction", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(RideStatusPatchSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const { status: to, reason, cancel_reason: cancelReason } = parsed.data;

  const ride = await loadRide(id);
  if (!ride) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const authUser = await getAuthUser().catch(() => null);
  const role = await resolveRole(ride, session.userId, Boolean(authUser?.isAdmin));
  if (!role) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let result: TransitionResult;
  if (to === "cancelled") {
    const reasonText = [cancelReason, reason].filter(Boolean).join(": ") || null;
    result = await cancelRide({ rideId: id, actor: role, reason: reasonText });
  } else {
    const check = canTransition(ride.status, to, role);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.code });
    result = to === "completed" ? await completeRide(id) : await advanceRide(id, to);
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code });

  // Push best-effort către rider la 'arriving' (FEATURE_PUSH e oprit în prod).
  if (result.status === "arriving" && ride.rider_user_id) {
    void sendMobilityPush(ride.rider_user_id, "driverArriving", { url: `/go/${id}`, tag: `ride-${id}` });
  }

  log.info({ rideId: id, to, role }, "ride status changed");
  const { ok: _ok, ...payload } = result;
  return NextResponse.json(payload);
}
