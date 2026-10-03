/**
 * Fragmente SQL comune pentru Stays (fără valori de la utilizator — doar
 * structură). Țin într-un singur loc definiția „listare Stays rezervabilă” și
 * „rezervare care ocupă calendarul”.
 */

/** Listare Stays cu gazdă (model unic, 0051). Alias tabel: p. */
export const STAY_LISTING_SQL = `p.listing_type = 'listing'
  AND p.metadata->>'vertical' = 'stays'
  AND COALESCE(p.metadata->>'host_user_id', '') <> ''
  AND COALESCE((p.metadata->>'stays_unclaimed')::boolean, false) = false`;

/** Listare publică (activă). Alias tabel: p. */
export const PUBLIC_STAY_SQL = `${STAY_LISTING_SQL} AND p.status = 'active'`;

/**
 * Rezervare care ocupă nopțile ACUM. Alias tabel: b.
 * Un 'pending' expirat nu mai blochează, chiar dacă cron-ul n-a rulat încă.
 */
export const BLOCKING_BOOKING_SQL = `(b.status IN ('requested','confirmed')
  OR (b.status = 'pending' AND (b.expires_at IS NULL OR b.expires_at > now())))`;

/** Normalizare diacritice RO în SQL (pereche cu normalizeText din search.ts). */
export function sqlNormalize(expr: string): string {
    return `lower(translate(${expr}, 'ăâîșşțţĂÂÎȘŞȚŢ', 'aaissttAAISSTT'))`;
}
