/**
 * Constante dispatch partajate client + server (fără importuri de server).
 * Sursa unică pentru viteze/raze — importate de engine (server) și de
 * componentele de tracking (client).
 *
 * Valorile sunt configurabile prin env (pe server; pe client rămân
 * default-urile), cu default-urile de mai jos ca fallback — același model
 * ca lib/config/commerce.ts (parse + validare + fallback).
 */

function intFromEnv(name: string, defaultValue: number, min: number, max: number): number {
    const raw = typeof process !== "undefined" ? process.env[name] : undefined;
    if (!raw) return defaultValue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return defaultValue;
    return Math.round(parsed);
}

function radiiFromEnv(name: string, defaultValue: readonly number[]): readonly number[] {
    const raw = typeof process !== "undefined" ? process.env[name] : undefined;
    if (!raw) return defaultValue;
    const parsed = raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
    if (parsed.length === 0) return defaultValue;
    return parsed;
}

/** TTL (secunde) al unei oferte trimise curierului (default 45). */
export const OFFER_TTL_SECONDS = intFromEnv("DISPATCH_OFFER_TTL_SECONDS", 45, 5, 600);

/** Câți curieri primesc oferta simultan într-un val (default 5). */
export const MAX_COURIERS_PER_WAVE = intFromEnv("DISPATCH_MAX_COURIERS_PER_WAVE", 5, 1, 50);

/** Un curier online fără heartbeat de atâtea secunde e considerat offline (default 120). */
export const COURIER_STALE_SECONDS = intFromEnv("DISPATCH_COURIER_STALE_SECONDS", 120, 30, 3600);

/**
 * Grația (secunde) pentru un curier/șofer CU job activ (cursă/livrare în curs):
 * pe mobil, navigarea în Maps/Waze pune aplicația în fundal și heartbeat-ul JS
 * se oprește — nu-l scoatem offline după COURIER_STALE_SECONDS cât are un job
 * (default 900 = 15 min). Audit food-go #10.
 */
export const COURIER_ACTIVE_JOB_STALE_SECONDS = intFromEnv("DISPATCH_ACTIVE_JOB_STALE_SECONDS", 900, 60, 7200);

/** raza (km) per val; după ultimul val fără accept → no_courier */
export const WAVE_RADII_KM: readonly number[] = radiiFromEnv("DISPATCH_SEARCH_RADII_KM", [2, 5, 10]);

/** Viteze medii km/h per tip vehicul — folosite pentru ETA post-pickup.
 *  Override prin env: DISPATCH_SPEED_KMH_<TIP> (ex. DISPATCH_SPEED_KMH_BIKE=18). */
export const VEHICLE_SPEED_KMH: Record<string, number> = {
    foot: intFromEnv("DISPATCH_SPEED_KMH_FOOT", 5, 1, 100),
    bike: intFromEnv("DISPATCH_SPEED_KMH_BIKE", 15, 1, 100),
    scooter: intFromEnv("DISPATCH_SPEED_KMH_SCOOTER", 25, 1, 100),
    motorcycle: intFromEnv("DISPATCH_SPEED_KMH_MOTORCYCLE", 30, 1, 100),
    car: intFromEnv("DISPATCH_SPEED_KMH_CAR", 30, 1, 100),
    van: intFromEnv("DISPATCH_SPEED_KMH_VAN", 28, 1, 100),
};
