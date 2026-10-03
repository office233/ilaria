/**
 * GET /api/couriers/active-job — jobul activ al șoferului/curierului logat
 * (cursă sau livrare). Panoul șoferului îl citește la fiecare încărcare, deci
 * un reload în mijlocul cursei nu mai pierde cursa.
 */
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { getCourierForUser, getDriverActiveJob, getRideToRate } from "@/lib/rides/driver-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("courierStatus", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const courier = await getCourierForUser(session.userId);
  if (!courier) return NextResponse.json({ error: "not_a_courier" }, { status: 403 });

  const job = await getDriverActiveJob(courier);
  // Rating pasager pentru cursa tocmai încheiată (și pe card) — audit #18.
  const rate_ride = courier.kind === "driver" && !job ? await getRideToRate(courier.id) : null;
  return NextResponse.json({ job, rate_ride });
}
