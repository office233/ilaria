/**
 * PATCH /api/rides/[id]/dispatch — șoferul acceptă/refuză oferta cursei.
 * Body: { accept: boolean }. Atribuire atomică prin dispatch engine;
 * acceptOffer setează rides.driver_id + status='accepted' în tranzacție.
 * Răspunde cu jobul activ (același format ca /api/couriers/active-job).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";
import { acceptOffer, declineOffer, getJobForRide } from "@/lib/dispatch/engine";
import { getCourierForUser, getDriverActiveJob } from "@/lib/rides/driver-job";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ accept: z.boolean() });

/** Codurile de eroare ale engine-ului → coduri stabile pentru UI. */
function errorCode(status: number): string {
  if (status === 410) return "offer_expired";
  if (status === 403) return "courier_suspended";
  if (status === 404) return "job_not_found";
  return "job_taken";
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const session = await getAuthSession();
    if (!session?.userId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    const rl = await rateLimit("rideAction", session.userId);
    if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });

    const courier = await getCourierForUser(session.userId);
    if (!courier || courier.kind !== "driver" || courier.verification_status !== "approved") {
      return NextResponse.json({ success: false, error: "not_approved_driver" }, { status: 403 });
    }

    const job = await getJobForRide(id);
    if (!job || job.status !== "searching") {
      return NextResponse.json({ success: false, error: "job_not_found" }, { status: 404 });
    }

    if (!parsed.data.accept) {
      await declineOffer(job.id, courier.id);
      return NextResponse.json({ success: true, accepted: false });
    }

    const result = await acceptOffer(job.id, courier.id);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: errorCode(result.code) }, { status: result.code });
    }
    await dbQuery(`UPDATE rides SET accepted_at = COALESCE(accepted_at, now()), updated_at = now() WHERE id = $1`, [id]);

    const active = await getDriverActiveJob(courier);
    return NextResponse.json({ success: true, accepted: true, job: active });
  } catch (error: unknown) {
    logger.error({ err: error }, "[rides/dispatch] PATCH error");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
