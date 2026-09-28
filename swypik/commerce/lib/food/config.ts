/**
 * Swypik Food — parametri operaționali, configurabili prin env (default-uri
 * documentate într-un singur loc; înainte erau literale în 3 fișiere:
 * `avg_prep + 25…+40` în FoodClient, MenuClient și POST /api/local-orders).
 *
 * Taxa de livrare NU e aici: vine din DB (pricing_zones → lib/pricing/delivery.ts,
 * fallback local_merchants.delivery_fee_cents).
 */
import type { RateLimitConfig } from "@/lib/security/rate-limit";

function intFromEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return Math.round(n);
}

/** Minute de drum adăugate peste timpul de preparare (estimare optimistă). */
export const FOOD_ETA_TRAVEL_MIN_MINUTES = intFromEnv("FOOD_ETA_TRAVEL_MIN_MINUTES", 25, 0, 240);
/** Minute de drum adăugate peste timpul de preparare (estimare pesimistă). */
export const FOOD_ETA_TRAVEL_MAX_MINUTES = intFromEnv("FOOD_ETA_TRAVEL_MAX_MINUTES", 40, 0, 240);
/** Prep implicit când restaurantul nu și-a setat avg_prep_minutes. */
export const FOOD_DEFAULT_PREP_MINUTES = intFromEnv("FOOD_DEFAULT_PREP_MINUTES", 20, 1, 240);

export type EtaRange = { min: number; max: number };

/** Intervalul de livrare afișat clientului (minute de la plasare). */
export function etaRange(avgPrepMinutes: number | null | undefined): EtaRange {
  const prep = Number(avgPrepMinutes) > 0 ? Number(avgPrepMinutes) : FOOD_DEFAULT_PREP_MINUTES;
  const min = prep + FOOD_ETA_TRAVEL_MIN_MINUTES;
  return { min, max: Math.max(min, prep + FOOD_ETA_TRAVEL_MAX_MINUTES) };
}

/** Estimarea salvată pe comandă (estimated_delivery_at = now + max). */
export function etaMinutesForOrder(avgPrepMinutes: number | null | undefined): number {
  return etaRange(avgPrepMinutes).max;
}

/** Rate limits pentru rutele noi Food (nu atingem tabela globală partajată). */
export const FOOD_RATE_LIMITS = {
  /** „Sugerează proprietarului”: per user/IP, pe oră. */
  suggest: {
    limit: intFromEnv("FOOD_SUGGEST_RATE_LIMIT", 20, 1, 1000),
    window: 3600,
  } satisfies RateLimitConfig,
  /** Cereri de revendicare: per user, pe zi. */
  claim: {
    limit: intFromEnv("FOOD_CLAIM_RATE_LIMIT", 3, 1, 100),
    window: 86_400,
  } satisfies RateLimitConfig,
  /** Anulări de către client. */
  cancel: { limit: 10, window: 300 } satisfies RateLimitConfig,
} as const;

/** Paginare listă restaurante. */
export const FOOD_LIST_DEFAULT_LIMIT = 24;
export const FOOD_LIST_MAX_LIMIT = 60;
