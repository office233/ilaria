/** Produsele salvate (wishlist) ale utilizatorului, în forma cardurilor de catalog. */
import { dbQuery } from "@/lib/db";
import { loadProductTranslations } from "@/lib/db/product-queries";
import type { CatalogCard } from "./catalog";

export type SavedProduct = CatalogCard & { available: boolean };

export async function listSavedProducts(userId: string, locale: string, limit = 200): Promise<SavedProduct[]> {
  const { rows } = await dbQuery<{
    id: string;
    title: string;
    price_cents: number | null;
    compare_at_price_cents: number | null;
    currency: string;
    image_url: string | null;
    available: boolean;
  }>(
    `SELECT p.id::text AS id, p.title, p.price_cents, p.compare_at_price_cents, p.currency, p.image_url,
            (p.status = 'active' AND p.effective_label = 'safe' AND COALESCE(p.is_adult, false) = false
              AND COALESCE(p.price_cents, 0) > 0) AS available
       FROM saved_products sp
       JOIN marketplace_products p ON p.id = sp.product_id
      WHERE sp.user_id = $1
      ORDER BY sp.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  const translations = rows.length ? await loadProductTranslations(rows.map((r) => r.id), locale) : new Map();
  return rows.map((r) => {
    const price = Number(r.price_cents) || 0;
    const compare = Number(r.compare_at_price_cents) || 0;
    return {
      id: r.id,
      title: translations.get(r.id)?.title || r.title,
      priceCents: price,
      compareAtCents: compare > price ? compare : null,
      currency: String(r.currency || "RON").trim().toUpperCase(),
      image: r.image_url,
      hasVideo: false,
      rating: null,
      ratingCount: 0,
      available: Boolean(r.available),
    };
  });
}
