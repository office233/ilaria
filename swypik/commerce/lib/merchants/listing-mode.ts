/**
 * Modul de listare al unui comerciant local (coloana `local_merchants.listing_mode`,
 * migrarea 20260926_0006):
 *  - `orderable`    — partener Swypik: meniul poate fi comandat.
 *  - `suggest_only` — profil nerevendicat (ex. importat din OpenStreetMap): apare
 *                     doar ca „sugerează proprietarului", fără comenzi.
 */
export const MERCHANT_LISTING_MODES = ["orderable", "suggest_only"] as const;
export type MerchantListingMode = (typeof MERCHANT_LISTING_MODES)[number];

/** Doar `orderable` explicit permite comenzi (valoare lipsă/necunoscută = nu). */
export function isMerchantOrderable(m: { listing_mode?: unknown }): boolean {
  return m.listing_mode === "orderable";
}

/** Fragment SQL (fără input utilizator) pentru SELECT-urile publice. */
export const LISTING_MODE_SELECT_SQL =
  "listing_mode, (listing_mode = 'orderable') AS is_orderable";
