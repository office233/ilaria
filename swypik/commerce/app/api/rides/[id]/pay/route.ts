/**
 * Plata unei curse.
 *
 * POST /api/rides/[id]/pay
 *   { action: "authorize" }    — rider, card: creează/refolosește hold-ul Stripe
 *                                → { client_secret, amount_cents } pentru Payment Element.
 *   { action: "confirm" }      — rider, după confirmPayment: verificare la Stripe
 *                                (requires_capture) → 'authorized' → pornește dispatch-ul.
 *   { action: "collect_cash" } — driver, cash: confirmă încasarea pe cursa 'completed'.
 *
 * GET — starea plății (rider/driver/admin).
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { RidePayActionSchema } from "@/lib/validation/rides";
import { parseBody } from "@/lib/validation/schemas";
import { loadRide, resolveRole, type RideRole } from "@/lib/rides/service";
import { getGoSettings } from "@/lib/rides/settings";
import { confirmCardAndDispatch } from "@/lib/rides/dispatch-start";
import { authorizeRidePayment, RidePaymentError } from "@/lib/payments/mobility-stripe";
import { onRidePaid } from "@/lib/referral/validation";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "rides/pay" });

async function access(id: string): Promise<{ role: RideRole } | NextResponse> {
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ride = await loadRide(id);
  if (!ride) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await getAuthUser().catch(() => null);
  const role = await resolveRole(ride, session.userId, Boolean(user?.isAdmin));
  if (!role) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rl = await rateLimit("rideAction", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return { role };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await access(id);
  if (a instanceof NextResponse) return a;
  const { rows } = await dbQuery(
    `SELECT payment_method, payment_status, tip_cents, final_fare_cents, estimated_fare_cents,
            authorized_amount_cents, cancel_fee_status, settled_at
       FROM rides WHERE id = $1`,
    [id],
  );
  return NextResponse.json({ payment: rows[0] ?? null });
}

async function collectCash(id: string): Promise<NextResponse> {
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE rides SET payment_status = 'collected_cash', updated_at = now()
      WHERE id = $1 AND payment_method = 'cash' AND status = 'completed'
        AND payment_status IN ('unpaid', 'collected_cash')
      RETURNING id`,
    [id],
  );
  if (!rows.length) return NextResponse.json({ error: "bad_state" }, { status: 409 });
  // Referral: cash-ul e o plată reală — validează atribuirea pasagerului.
  await onRidePaid(id, `cash_ride_${id}`);
  return NextResponse.json({ payment_status: "collected_cash" });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await access(id);
  if (a instanceof NextResponse) return a;

  const parsed = parseBody(RidePayActionSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const { action } = parsed.data;

  try {
    if (action === "collect_cash") {
      if (a.role !== "driver" && a.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
      return await collectCash(id);
    }
    if (a.role !== "rider") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (action === "authorize") {
      const settings = await getGoSettings();
      const r = await authorizeRidePayment(id, settings.fare_overrun_cap_bps);
      return NextResponse.json({ client_secret: r.client_secret, amount_cents: r.amount_cents });
    }
    return NextResponse.json(await confirmCardAndDispatch(id));
  } catch (err) {
    if (err instanceof RidePaymentError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    log.error({ err, rideId: id, action }, "ride pay failed");
    return NextResponse.json({ error: "payment_failed" }, { status: 500 });
  }
}
