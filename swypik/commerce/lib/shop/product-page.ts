/**
 * Date + SEO pentru pagina de produs (server). Separat de componenta paginii ca
 * să rămână mică și testabilă.
 */
import { dbQuery } from "@/lib/db";
import { APP_URL } from "@/lib/app-url";
import type { ProductDetail } from "@/lib/products/get-product-detail";
import type { ReviewSummary } from "./reviews";

export type ProductClip = {
  id: string;
  title: string;
  playbackUrl: string;
  thumbnailUrl: string | null;
  creatorName: string | null;
};

/** Clipurile publice care etichetează produsul (product_refs sau video_product_links). */
export async function getProductClips(productId: string, limit = 12): Promise<ProductClip[]> {
  const { rows } = await dbQuery<{
    id: string;
    title: string | null;
    playback_url: string | null;
    thumbnail_url: string | null;
    creator_name: string | null;
  }>(
    `SELECT v.id::text AS id, v.title, v.playback_url, v.thumbnail_url, u.display_name AS creator_name
       FROM videos v
       LEFT JOIN users u ON u.id = v.creator_id
      WHERE v.status = 'ready' AND v.visibility = 'public'
        AND COALESCE(v.is_hidden, false) = false AND v.effective_label = 'safe'
        AND v.playback_url IS NOT NULL
        AND (
          v.product_refs @> jsonb_build_array(jsonb_build_object('product_id', $1::text))
          OR v.product_refs @> jsonb_build_array(to_jsonb($1::text))
          OR EXISTS (SELECT 1 FROM video_product_links vpl WHERE vpl.video_id = v.id AND vpl.product_id::text = $1)
        )
      ORDER BY v.view_count DESC NULLS LAST, v.published_at DESC NULLS LAST
      LIMIT $2`,
    [productId, limit],
  );
  return rows
    .filter((r) => r.playback_url)
    .map((r) => ({
      id: r.id,
      title: r.title || "",
      playbackUrl: String(r.playback_url),
      thumbnailUrl: r.thumbnail_url,
      creatorName: r.creator_name,
    }));
}

function plainText(html: string | null | undefined, max: number): string {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** JSON-LD Product: moneda reală a produsului, rating doar din recenzii reale. */
export function buildProductJsonLd(detail: ProductDetail, summary: ReviewSummary, locale: string) {
  const { product, variants } = detail;
  const url = `${APP_URL}/product/${product.id}`;
  const inStock =
    variants.length > 0 ? variants.some((v) => v.stock > 0) : product.availableStock == null || product.availableStock > 0;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: plainText(product.description || product.title, 300),
    image: product.images?.[0],
    url,
    inLanguage: locale,
    sku: product.id,
    ...(product.brand ? { brand: { "@type": "Brand", name: product.brand } } : {}),
    offers: {
      "@type": "Offer",
      url,
      price: product.price,
      priceCurrency: product.currency,
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      ...(product.seller ? { seller: { "@type": "Organization", name: product.seller.name } } : {}),
    },
    ...(summary.average != null && summary.total > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: summary.average,
            bestRating: 5,
            worstRating: 1,
            ratingCount: summary.total,
          },
        }
      : {}),
  };
}

/** Canonical + hreflang din slug-urile localizate (product_translations). */
export async function getProductAlternates(
  productId: string,
  locale: string,
  locales: readonly string[],
): Promise<{ canonical: string; languages?: Record<string, string> }> {
  const base = `${APP_URL}/product`;
  let canonical = `${base}/${productId}`;
  try {
    const { rows } = await dbQuery<{ locale: string; slug: string | null }>(
      `SELECT locale, NULLIF(slug, '') AS slug FROM product_translations WHERE product_id = $1`,
      [productId],
    );
    if (rows.length === 0) return { canonical };
    const slugs = new Map(rows.map((r) => [r.locale, r.slug]));
    const languages: Record<string, string> = { "x-default": `${base}/${productId}` };
    for (const l of locales) {
      if (!slugs.has(l)) continue;
      const slug = slugs.get(l);
      languages[l] = slug ? `${base}/${slug}` : `${base}/${productId}?locale=${l}`;
    }
    const active = slugs.get(locale);
    if (active) canonical = `${base}/${active}`;
    return { canonical, languages };
  } catch {
    return { canonical };
  }
}

export function buildProductDescription(detail: ProductDetail, fallback: string): string {
  const p = detail.product;
  return p.seoDescription || (p.description ? plainText(p.description, 155) : fallback);
}
