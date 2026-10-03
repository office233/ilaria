/** Tipuri partajate client/server pentru Swypik Food (fără cod server). */

export type MerchantSummary = {
  id: string;
  kind: string;
  name: string;
  slug: string;
  description: string | null;
  cuisines: string[];
  address: string | null;
  city: string | null;
  image_url: string | null;
  listing_mode: "orderable" | "suggest_only";
  is_orderable: boolean;
  is_claimed: boolean;
  has_menu: boolean;
  suggestion_count: number;
  distance_km: number | null;
  is_open: boolean | null;
  hours_known: boolean;
  delivery_fee_cents: number | null;
  min_order_cents: number | null;
  eta_min: number | null;
  eta_max: number | null;
};

export type MenuChoice = { id?: string; name: string; price_cents?: number };
export type MenuOption = { name: string; required?: boolean; max?: number; choices?: MenuChoice[] };

export type MenuItem = {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  image_url: string | null;
  options: MenuOption[];
  allergens: string[];
};

/** Secțiune de meniu; id null = articole fără categorie (eticheta vine din i18n). */
export type MenuSection = { id: string | null; name: string | null; items: MenuItem[] };

export type CartLine = {
  menu_item_id: string;
  name: string;
  unit_price_cents: number;
  qty: number;
  option_ids: string[];
  option_names: string[];
};

/** Coduri de eroare stabile întoarse de API-urile Food (traduse în UI: foodHub.errors.<code>). */
export const FOOD_ERROR_CODES = [
  "merchant_unavailable", "merchant_not_orderable", "merchant_closed", "item_unavailable",
  "invalid_option", "below_min_order", "out_of_range", "rate_limited", "validation_error",
  "unauthorized", "not_found", "invalid_transition", "already_claimed", "claim_pending",
  "not_claimable", "server_error",
] as const;
export type FoodErrorCode = (typeof FOOD_ERROR_CODES)[number];

export function isFoodErrorCode(c: unknown): c is FoodErrorCode {
  return typeof c === "string" && (FOOD_ERROR_CODES as readonly string[]).includes(c);
}
