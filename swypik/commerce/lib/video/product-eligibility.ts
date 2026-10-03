/**
 * Un produs etichetat pe clip trebuie să fie „eligibil pentru feed”: altfel
 * feed-ul (app/api/explore/feed) ascunde tot clipul. Aceleași condiții ca acolo,
 * într-un singur loc, folosite de căutarea din wizard și de validarea la publicare.
 */
import { dbQuery } from "@/lib/db";

/** Condiții pe alias-ul `p` (marketplace_products). */
export const FEED_ELIGIBLE_PRODUCT_SQL = `
  p.status = 'active'
  AND COALESCE(p.is_adult, false) = false
  AND p.effective_label = 'safe'
  AND COALESCE(p.price_cents, 0) > 0
  AND NULLIF(BTRIM(p.image_url), '') IS NOT NULL
  AND NULLIF(BTRIM(p.taxonomy_node_slug), '') IS NOT NULL`;

export type TaggableProduct = { id: string; title: string; image_url: string | null; price_cents: number; currency: string };

export async function isFeedEligibleProduct(productId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT p.id FROM marketplace_products p WHERE p.id::text = $1 AND ${FEED_ELIGIBLE_PRODUCT_SQL} LIMIT 1`,
    [productId],
  );
  return rows.length > 0;
}

export async function searchTaggableProducts(query: string, limit: number): Promise<TaggableProduct[]> {
  const q = query.trim().slice(0, 80);
  if (!q) return [];
  const { rows } = await dbQuery<TaggableProduct>(
    `SELECT p.id::text AS id, p.title, p.image_url, p.price_cents, COALESCE(p.currency, 'RON') AS currency
       FROM marketplace_products p
      WHERE ${FEED_ELIGIBLE_PRODUCT_SQL}
        AND p.title ILIKE '%' || $1 || '%'
      ORDER BY p.updated_at DESC NULLS LAST
      LIMIT $2`,
    [q.replace(/[%_\\]/g, (c) => `\\${c}`), limit],
  );
  return rows;
}
