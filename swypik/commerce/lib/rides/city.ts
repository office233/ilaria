/**
 * Orașul unei curse — derivat EXCLUSIV server-side din coordonatele de pickup
 * (reverse geocoding Nominatim, cache Redis 24h). Clientul nu poate impune
 * orașul (altfel ar putea alege o zonă de pricing mai ieftină).
 *
 * Orașul returnat e cel CANONIC al zonei tarifare (aliasurile din
 * `pricing_city_aliases`: Otopeni → București), ca dispatch-ul să caute
 * șoferii orașului zonei. Fără oraș sau fără zonă activă → NoZoneError (422).
 */
import { cityFromCoords } from "@/lib/geo/nominatim";
import { findZone, listZones, type PricingZone } from "@/lib/pricing/engine";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "rides-city" });

export class NoZoneError extends Error {
  constructor(public readonly city: string | null) {
    super("no_zone");
    this.name = "NoZoneError";
  }
}

async function geocodeCity(pickup: { lat: number; lng: number }): Promise<string> {
  const city = await cityFromCoords(pickup.lat, pickup.lng);
  if (!city) {
    log.info({ pickup }, "reverse geocoding nu a returnat oraș");
    throw new NoZoneError(null);
  }
  return city;
}

/**
 * Derivă orașul din pickup și verifică existența unei pricing_zone active
 * pentru (oraș, ride, clasă). Returnează zona (orașul canonic = zone.city).
 */
export async function resolveRideZone(
  pickup: { lat: number; lng: number },
  vehicleClass: string,
  country = "RO",
): Promise<PricingZone> {
  const city = await geocodeCity(pickup);
  const zone = await findZone(city, "ride", vehicleClass, country);
  if (!zone) throw new NoZoneError(city);
  return zone;
}

/** Compat: doar orașul canonic. */
export async function resolveRideCity(
  pickup: { lat: number; lng: number },
  vehicleClass: string,
  country = "RO",
): Promise<string> {
  return (await resolveRideZone(pickup, vehicleClass, country)).city;
}

/** Toate clasele cu zonă activă la pickup (selectorul de clasă al pasagerului). */
export async function resolveRideZones(
  pickup: { lat: number; lng: number },
  country = "RO",
): Promise<{ city: string; zones: PricingZone[] }> {
  const raw = await geocodeCity(pickup);
  const zones = await listZones(raw, "ride", country);
  if (!zones.length) throw new NoZoneError(raw);
  return { city: zones[0].city, zones };
}
