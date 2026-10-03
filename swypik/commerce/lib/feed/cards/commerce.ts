/**
 * Carduri de comerț pentru feed: produse din magazin (doar active, eligibile,
 * în stoc, cumpărabile — fără listări de verticală) și preparate de la
 * comercianții locali PARTENERI (listing_mode = 'orderable', meniu disponibil).
 * Ordine stabilă (created_at, id) → cardul n e același între pagini.
 */
import { dbQuery } from "@/lib/db";
import { productAttachSql } from "../visibility";
import type { FeedCard } from "../types";

type ProductRow = { id: string; title: string; image_url: string | null; price_cents: number | string; currency: string | null };

export function toProductCard(r: ProductRow): FeedCard | null {
  const cents = Number(r.price_cents);
  if (!r.image_url || !Number.isFinite(cents) || cents <= 0) return null;
  return {
    kind: "product",
    id: String(r.id),
    title: r.title,
    subtitle: null,
    image: r.image_url,
    href: `/product/${encodeURIComponent(String(r.id))}`,
    price: { cents, currency: String(r.currency || "RON").toUpperCase(), unit: "item" },
    summary: null,
    attribution: null,
    sourceUrl: null,
    viewerCount: null,
    isFree: null,
  };
}

export async function getShopFeedCards(limit: number): Promise<FeedCard[]> {
  const { rows } = await dbQuery<ProductRow>(
    `SELECT p.id::text AS id, p.title, p.image_url, p.price_cents, p.currency
       FROM marketplace_products p
      WHERE ${productAttachSql({ softBlock: true })}
        AND COALESCE(p.listing_type, 'product') = 'product'
        AND COALESCE(p.metadata->>'vertical', '') NOT IN ('fly', 'go')
        AND COALESCE(p.inventory_status, '') <> 'out_of_stock'
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(toProductCard).filter((c): c is FeedCard => c !== null);
}

type MenuRow = {
  id: string;
  name: string;
  image_url: string | null;
  price_cents: number | string;
  currency: string | null;
  merchant_name: string;
  merchant_slug: string | null;
  merchant_id: string;
};

export function toFoodCard(r: MenuRow): FeedCard | null {
  const cents = Number(r.price_cents);
  if (!r.image_url || !Number.isFinite(cents) || cents <= 0) return null;
  return {
    kind: "food",
    id: String(r.id),
    title: r.name,
    subtitle: r.merchant_name,
    image: r.image_url,
    href: `/food/${encodeURIComponent(r.merchant_slug || r.merchant_id)}`,
    price: { cents, currency: String(r.currency || "RON").toUpperCase(), unit: "item" },
    summary: null,
    attribution: null,
    sourceUrl: null,
    viewerCount: null,
    isFree: null,
  };
}

export async function getFoodFeedCards(limit: number): Promise<FeedCard[]> {
  const { rows } = await dbQuery<MenuRow>(
    `SELECT mi.id::text AS id, mi.name, mi.image_url, mi.price_cents, mi.currency,
            m.name AS merchant_name, m.slug AS merchant_slug, m.id::text AS merchant_id
       FROM menu_items mi
       JOIN local_merchants m ON m.id = mi.merchant_id
      WHERE m.status = 'active'
        AND m.listing_mode = 'orderable'
        AND mi.is_available = true
        AND mi.price_cents > 0
        AND NULLIF(BTRIM(mi.image_url), '') IS NOT NULL
      ORDER BY mi.created_at DESC, mi.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(toFoodCard).filter((c): c is FeedCard => c !== null);
}
