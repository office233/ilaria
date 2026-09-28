/**
 * Taxa de livrare dinamică pentru Eats.
 *
 * Dacă merchantul are oraș + coordonate ȘI există zonă `delivery` activă →
 * tarif din pricing engine (distanță merchant → client).
 * ORICE altceva (fără zonă, fără coordonate, eroare) → fallback OBLIGATORIU
 * la `local_merchants.delivery_fee_cents` fix, ca să nu rupem producția.
 */
import { logger } from "@/lib/logger";
import { estimate } from "./engine";

const log = logger.child({ service: "pricing-delivery" });

export type DeliveryFeeResult = {
  fee_cents: number;
  source: "zone" | "fixed";
  zone_id: string | null;
  distance_km: number | null;
  surge_multiplier: number | null;
  breakdown: Record<string, unknown> | null;
};

export async function resolveDeliveryFee(params: {
  merchant: {
    delivery_fee_cents?: number | null;
    location_city?: string | null;
    location_country?: string | null;
    location_lat?: number | null;
    location_lng?: number | null;
  };
  dropoff: { lat?: number | null; lng?: number | null };
}): Promise<DeliveryFeeResult> {
  const fixed = params.merchant.delivery_fee_cents ?? 0;
  const fallback: DeliveryFeeResult = {
    fee_cents: fixed,
    source: "fixed",
    zone_id: null,
    distance_km: null,
    surge_multiplier: null,
    breakdown: null,
  };

  const { location_city, location_lat, location_lng } = params.merchant;
  const { lat, lng } = params.dropoff;
  if (
    !location_city ||
    typeof location_lat !== "number" ||
    typeof location_lng !== "number" ||
    typeof lat !== "number" ||
    typeof lng !== "number"
  ) {
    return fallback;
  }

  try {
    const est = await estimate({
      kind: "delivery",
      city: location_city,
      country: params.merchant.location_country ?? "RO",
      vehicle_class: "bike",
      pickup: { lat: location_lat, lng: location_lng },
      dropoff: { lat, lng },
    });
    return {
      fee_cents: est.total_cents,
      source: "zone",
      zone_id: est.zone_id,
      distance_km: est.distance_km,
      surge_multiplier: est.breakdown.surge_multiplier,
      breakdown: { ...est.breakdown, duration_min: est.duration_min },
    };
  } catch (err) {
    if ((err as Error)?.message !== "no_zone") {
      log.warn({ err, city: location_city }, "dynamic delivery fee failed — using fixed fee");
    }
    return fallback;
  }
}
