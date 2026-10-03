/**
 * Forma publică a unui comerciant Food (listă + pagina restaurantului).
 *
 * Profilurile `suggest_only` (nerevendicate, ex. OSM) sunt afișate onest:
 * fără taxă de livrare, fără timp de livrare, fără „Deschis”, fără comandă
 * minimă — nu livrăm de la ei, deci nu pretindem că o facem.
 */
import { etaRange } from "./config";
import { hasKnownHours, isOpenNow } from "@/lib/merchants/hours";
import { normalizeCuisines } from "@/lib/merchants/cuisines";
import type { MerchantSummary } from "./types";

export type MerchantRow = {
  id: string;
  kind: string;
  name: string;
  slug: string;
  description: string | null;
  cuisine_types: string[] | null;
  address: string | null;
  location_city: string | null;
  delivery_fee_cents: number | null;
  min_order_cents: number | null;
  avg_prep_minutes: number | null;
  opening_hours: unknown;
  is_open_override: boolean | null;
  image_url: string | null;
  listing_mode: string;
  is_claimed?: boolean | null;
  suggestion_count?: number | null;
  menu_count?: number | string | null;
  distance_km?: number | string | null;
};

/**
 * Poze stoc (Unsplash) puse automat pe profilurile importate: nu le prezentăm ca
 * poza restaurantului (audit food-go #26) — UI-ul arată placeholder-ul bucătăriei.
 */
export function isStockPhoto(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return /(^|\.)unsplash\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function toMerchantSummary(m: MerchantRow, now: Date = new Date()): MerchantSummary {
  const orderable = m.listing_mode === "orderable";
  const menuCount = Number(m.menu_count ?? 0);
  const eta = orderable ? etaRange(m.avg_prep_minutes) : null;
  const distance = m.distance_km == null ? null : Number(m.distance_km);
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    slug: m.slug,
    description: m.description,
    cuisines: normalizeCuisines(m.cuisine_types),
    address: m.address,
    city: m.location_city,
    image_url: !m.is_claimed && isStockPhoto(m.image_url) ? null : m.image_url,
    listing_mode: orderable ? "orderable" : "suggest_only",
    is_orderable: orderable,
    is_claimed: Boolean(m.is_claimed),
    has_menu: menuCount > 0,
    suggestion_count: Number(m.suggestion_count ?? 0),
    distance_km: distance != null && Number.isFinite(distance) ? distance : null,
    // Doar pentru parteneri:
    is_open: orderable ? isOpenNow(m.opening_hours, m.is_open_override, now) : null,
    hours_known: orderable ? hasKnownHours(m.opening_hours) || m.is_open_override != null : false,
    delivery_fee_cents: orderable ? Number(m.delivery_fee_cents ?? 0) : null,
    min_order_cents: orderable ? Number(m.min_order_cents ?? 0) : null,
    eta_min: eta?.min ?? null,
    eta_max: eta?.max ?? null,
  };
}
