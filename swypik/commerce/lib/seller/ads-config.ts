/** Reguli de produs pentru Swypik Ads — un singur loc, importat de rută și de UI. */
export const AD_DAILY_BUDGET_MIN_RON = 10;
export const AD_DAILY_BUDGET_MAX_RON = 10_000;
export const AD_DAILY_BUDGET_DEFAULT_RON = 20;
// `mystery_drop` a fost scos (funcționalitatea Mystery Drop a fost ștearsă 2026-09);
// campaniile vechi de acest tip sunt închise de migrarea 20260928_0031.
export const AD_TYPES = ["boost_reel", "flash_sale"] as const;
export type AdType = (typeof AD_TYPES)[number];
export const AD_TARGET_ALL_RO = "all_ro";
/** Zonele de targetare oferite în formular (etichetele sunt traduse în UI). */
export const AD_TARGET_CITIES = [AD_TARGET_ALL_RO, "bucuresti", "cluj", "timisoara", "iasi", "brasov"] as const;
