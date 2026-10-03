/**
 * POST /api/rides/quote — oferta completă pentru ecranul de comandă:
 * clasele cu zonă activă la pickup (din pricing_zones, nu hardcodate),
 * tariful estimat per clasă, metodele de plată permise (go_settings +
 * taxe datorate) și grația de anulare gratuită.
 *
 * Orașul e derivat server-side din pickup (reverse geocoding + aliasuri).
 */
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";
import { estimate } from "@/lib/pricing/engine";
import { resolveRideZones, NoZoneError } from "@/lib/rides/city";
import { getGoSettings } from "@/lib/rides/settings";
import { allowedPaymentMethods } from "@/lib/rides/policy";
import { riderHasOwedFees } from "@/lib/rides/cancel-fee";
import { stripeConfigured } from "@/lib/payments/mobility-stripe";
import { RideQuoteSchema } from "@/lib/validation/rides";
import { parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "rides/quote" });

export async function POST(req: Request) {
  const session = await getAuthSession();
  const rl = await rateLimit("rideEstimate", session?.userId || `ip:${getClientIP(req)}`);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(RideQuoteSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const input = parsed.data;

  try {
    const { city, zones } = await resolveRideZones(input.pickup, input.country);
    const classes = await Promise.all(
      zones.map(async (z) => {
        const e = await estimate({
          city,
          country: input.country,
          kind: "ride",
          vehicle_class: z.vehicle_class,
          pickup: { lat: input.pickup.lat, lng: input.pickup.lng },
          dropoff: { lat: input.dropoff.lat, lng: input.dropoff.lng },
        });
        return {
          vehicle_class: z.vehicle_class,
          max_passengers: z.max_passengers ?? null,
          total_cents: e.total_cents,
          currency: e.currency,
          distance_km: e.distance_km,
          duration_min: e.duration_min,
          surge_multiplier: e.breakdown.surge_multiplier,
        };
      }),
    );
    const settings = await getGoSettings();
    const payment_methods = allowedPaymentMethods(settings, {
      stripeConfigured: stripeConfigured(),
      hasOwedFees: session?.userId ? await riderHasOwedFees(session.userId) : false,
    });
    return NextResponse.json({
      city,
      classes,
      payment_methods,
      free_cancel_grace_seconds: settings.free_cancel_grace_seconds,
      fare_overrun_cap_bps: settings.fare_overrun_cap_bps,
    });
  } catch (err) {
    if (err instanceof NoZoneError || (err as Error).message === "no_zone") {
      return NextResponse.json({ error: "no_zone", code: "no_zone" }, { status: 422 });
    }
    log.error({ err }, "quote failed");
    return NextResponse.json({ error: "estimate_failed" }, { status: 500 });
  }
}
