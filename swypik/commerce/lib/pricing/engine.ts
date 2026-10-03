/**
 * Pricing Engine — calcul de tarif EXCLUSIV server-side.
 *
 * Formula:
 *   raw   = base + per_km × distance + per_min × duration
 *   fare  = max(raw × surge, min_fare) + booking_fee
 *   (toate în cents integer; rotunjire la fiecare pas cu Math.round)
 *
 * Surge = max(surge manual activ din surge_rules, surge automat).
 * Surge automat: raport cereri_active / curieri_online pe zonă (ultimele
 * 15 min), mapat liniar și plafonat la 2.0 — vezi computeAutoSurge().
 *
 * Clientul primește DOAR rezultatul; nu se acceptă niciodată un preț de la client.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getDistance, type LatLng } from "./distance";

const log = logger.child({ service: "pricing-engine" });

export type PricingZone = {
  id: string;
  city: string;
  country: string;
  kind: "delivery" | "ride" | "errand";
  vehicle_class: "economy" | "comfort" | "van" | "bike";
  base_cents: number;
  per_km_cents: number;
  per_min_cents: number;
  min_fare_cents: number;
  booking_fee_cents: number;
  cancel_fee_cents: number;
  platform_commission_pct: string; // numeric din pg vine ca string
  courier_share_pct: string;
  currency: string;
  max_passengers?: number | null;
};

export type EstimateInput = {
  kind: "delivery" | "ride" | "errand";
  city: string;
  country?: string;
  vehicle_class?: "economy" | "comfort" | "van" | "bike";
  pickup: LatLng;
  dropoff: LatLng;
  at?: Date;
};

export type EstimateResult = {
  zone_id: string;
  distance_km: number;
  duration_min: number;
  breakdown: {
    base_cents: number;
    distance_cents: number;
    time_cents: number;
    booking_fee_cents: number;
    surge_multiplier: number;
    min_fare_applied: boolean;
    distance_provider: "google" | "haversine";
  };
  total_cents: number;
  currency: string;
};

const ZONE_COLUMNS = `id, city, country, kind, vehicle_class, base_cents, per_km_cents,
            per_min_cents, min_fare_cents, booking_fee_cents, cancel_fee_cents,
            platform_commission_pct, courier_share_pct, currency, max_passengers`;

/**
 * Orașul canonic al zonei: aliasurile (suburbii: Otopeni → București) din
 * `pricing_city_aliases`, comparate fără diacritice. Același unaccent ca
 * dispatch-ul și surge-ul („Bucuresti" == „București").
 */
const CANONICAL_CITY_SQL = `COALESCE(
      (SELECT a.city FROM pricing_city_aliases a
        WHERE unaccent(lower(a.alias)) = unaccent(lower($1)) AND a.country = $2 LIMIT 1),
      $1)`;

/** Zona activă pentru (oraș, țară, tip, clasă). null = fără zonă → caller face fallback. */
export async function findZone(
  city: string,
  kind: string,
  vehicleClass = "economy",
  country = "RO",
): Promise<PricingZone | null> {
  const { rows } = await dbQuery<PricingZone>(
    `SELECT ${ZONE_COLUMNS}
       FROM pricing_zones
      WHERE unaccent(lower(city)) = unaccent(lower(${CANONICAL_CITY_SQL}))
        AND country = $2 AND kind = $3
        AND vehicle_class = $4 AND active
      LIMIT 1`,
    [city, country, kind, vehicleClass],
  );
  return rows[0] ?? null;
}

/** Toate zonele active de un tip într-un oraș (clasele disponibile pentru pasager). */
export async function listZones(city: string, kind: string, country = "RO"): Promise<PricingZone[]> {
  const { rows } = await dbQuery<PricingZone>(
    `SELECT ${ZONE_COLUMNS}
       FROM pricing_zones
      WHERE unaccent(lower(city)) = unaccent(lower(${CANONICAL_CITY_SQL}))
        AND country = $2 AND kind = $3 AND active
      ORDER BY base_cents ASC, vehicle_class`,
    [city, country, kind],
  );
  return rows;
}

/** Surge manual activ (fereastra starts_at/ends_at conține `at`). 1.0 dacă nu există. */
async function getManualSurge(zoneId: string, at: Date): Promise<number> {
  const { rows } = await dbQuery<{ multiplier: string }>(
    `SELECT multiplier FROM surge_rules
      WHERE zone_id = $1 AND starts_at <= $2
        AND (ends_at IS NULL OR ends_at >= $2)
      ORDER BY multiplier DESC
      LIMIT 1`,
    [zoneId, at.toISOString()],
  );
  return rows[0] ? Number(rows[0].multiplier) : 1.0;
}

/**
 * Surge automat: cereri active de dispatch (ultimele 15 min) / curieri online pe oraș.
 *   ratio ≤ 1   → 1.0 (ofertă suficientă)
 *   ratio ≥ 3   → 2.0 (plafon)
 *   între       → interpolare liniară 1.0 → 2.0
 * Fără curieri online dar cu cereri → plafon 2.0.
 */
export async function computeAutoSurge(city: string, at: Date): Promise<number> {
  try {
    const { rows } = await dbQuery<{ demand: string; supply: string }>(
      `SELECT
         (SELECT count(*) FROM dispatch_jobs dj
           WHERE unaccent(lower(dj.city)) = unaccent(lower($1))
             AND dj.created_at > $2::timestamptz - interval '15 minutes'
             AND dj.status IN ('searching', 'assigned')) AS demand,
         (SELECT count(*) FROM couriers
           WHERE unaccent(lower(city)) = unaccent(lower($1)) AND is_online) AS supply`,
      [city, at.toISOString()],
    );
    const demand = Number(rows[0]?.demand ?? 0);
    const supply = Number(rows[0]?.supply ?? 0);
    if (demand === 0) return 1.0;
    if (supply === 0) return 2.0;
    const ratio = demand / supply;
    if (ratio <= 1) return 1.0;
    if (ratio >= 3) return 2.0;
    // liniar: ratio 1→3 mapat pe 1.0→2.0, rotunjit la 0.1
    return Math.round((1 + (ratio - 1) / 2) * 10) / 10;
  } catch (err) {
    log.warn({ err, city }, "auto surge computation failed — defaulting to 1.0");
    return 1.0;
  }
}

/** Calcul pur (fără I/O) — exportat pentru teste deterministe. */
export function computeFare(
  zone: Pick<
    PricingZone,
    "base_cents" | "per_km_cents" | "per_min_cents" | "min_fare_cents" | "booking_fee_cents"
  >,
  distanceKm: number,
  durationMin: number,
  surgeMultiplier: number,
): {
  base_cents: number;
  distance_cents: number;
  time_cents: number;
  booking_fee_cents: number;
  surge_multiplier: number;
  min_fare_applied: boolean;
  total_cents: number;
} {
  const base_cents = zone.base_cents;
  const distance_cents = Math.round(zone.per_km_cents * distanceKm);
  const time_cents = Math.round(zone.per_min_cents * durationMin);
  const raw = base_cents + distance_cents + time_cents;
  const surged = Math.round(raw * surgeMultiplier);
  const min_fare_applied = surged < zone.min_fare_cents;
  const fare = Math.max(surged, zone.min_fare_cents);
  return {
    base_cents,
    distance_cents,
    time_cents,
    booking_fee_cents: zone.booking_fee_cents,
    surge_multiplier: surgeMultiplier,
    min_fare_applied,
    total_cents: fare + zone.booking_fee_cents,
  };
}

/**
 * Estimare completă: zonă + distanță (Google/haversine, cache Redis) + surge.
 * Aruncă Error("no_zone") dacă nu există zonă activă — caller decide fallback.
 */
export async function estimate(input: EstimateInput): Promise<EstimateResult> {
  const at = input.at ?? new Date();
  const zone = await findZone(
    input.city,
    input.kind,
    input.vehicle_class ?? "economy",
    input.country ?? "RO",
  );
  if (!zone) throw new Error("no_zone");

  const dist = await getDistance(input.pickup, input.dropoff);

  const [manual, auto] = await Promise.all([
    getManualSurge(zone.id, at),
    computeAutoSurge(input.city, at),
  ]);
  const surge = Math.min(2.0, Math.max(manual, auto));

  const fare = computeFare(zone, dist.distance_km, dist.duration_min, surge);

  return {
    zone_id: zone.id,
    distance_km: dist.distance_km,
    duration_min: dist.duration_min,
    breakdown: {
      base_cents: fare.base_cents,
      distance_cents: fare.distance_cents,
      time_cents: fare.time_cents,
      booking_fee_cents: fare.booking_fee_cents,
      surge_multiplier: fare.surge_multiplier,
      min_fare_applied: fare.min_fare_applied,
      distance_provider: dist.provider,
    },
    total_cents: fare.total_cents,
    currency: zone.currency,
  };
}
