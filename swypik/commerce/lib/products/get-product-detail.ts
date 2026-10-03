/**
 * Server-side product detail fetcher.
 * Uses marketplace_products as the primary read model and enriches from AE tables when available.
 */

import { dbQuery } from "@/lib/db";

export type ProductDetail = {
  product: {
    id: string;
    pgId: number | null;
    aeProductId: string;
    title: string;
    titleRo: string | null;
    titleEn: string;
    description: string | null;
    seoTitle: string | null;
    seoDescription: string | null;
    localizedSlug: string | null;
    price: number;
    oldPrice: number | null;
    minPriceUsd: number;
    images: string[];
    video: string | null;
    hasVideo: boolean;
    rating: number | null;
    ratingCount: number | null;
    ordersCount: number | null;
    brand: string | null;
    category: string | null;
    categoryId: number | null;
    taxonomyNodeSlug: string | null;
    taxonomyPath: Array<{ slug: string; label: string }>;
    shipMethod: string | null;
    shipCostUsd: number;
    shipFree: boolean;
    shipDaysMin: number | null;
    shipDaysMax: number | null;
    shipTracking: boolean;
    deliveryDate: string | null;
    availableStock: number | null;
    color: string | null;
    colors: string[] | null;
    sizes: string[] | null;
    neckline: string | null;
    style: string | null;
    fabricType: string | null;
    material: string | null;
    patternType: string | null;
    sleeveStyle: string | null;
    waistline: string | null;
    season: string | null;
    silhouette: string | null;
    decoration: string[] | null;
    gender: string | null;
    storeName: string | null;
    storeRating: number;
    isEstimatedSocial: boolean;
    seller: { id: string; name: string } | null;
    /** 'product' = se cumpără prin coș; 'listing' = anunț/verticală (CTA propriu). */
    listingType: string;
    currency: string;
    /** Destinația CTA-ului pentru listări (doar căi interne, ex. /fly?dest=CDG). */
    ctaUrl: string | null;
  };
  variants: Array<{
    id: string;
    skuId: string;
    name: string;
    priceRon: number;
    priceUsd: number;
    image: string | null;
    stock: number;
    color: string | null;
    size: string | null;
  }>;
  colorMap: Record<string, { image: string | null; sizes: Array<{ size: string; price: number; stock: number; skuId: string }> }>;
  similar: Array<{
    id: string;
    title: string;
    price: number;
    oldPrice: number | undefined;
    image: string;
    hasVideo: boolean;
    rating: number;
    ratingAvg: number | null;
    ratingCount: number;
  }>;
};

const DETAIL_SELECT = `
  SELECT
    p.*,
    NULL::int AS ae_internal_id,
    NULL::text AS ae_product_id,
    NULL::text AS ae_title,
    NULL::text AS ae_title_ro,
    NULL::text AS product_type,
    NULL::text AS product_type_ro,
    NULL::text AS ae_brand,
    NULL::numeric AS min_price_usd,
    NULL::text AS video_url,
    NULL::boolean AS has_video,
    NULL::numeric AS rating,
    NULL::int AS rating_count,
    NULL::int AS orders_count,
    NULL::text AS ship_method,
    NULL::numeric AS ship_cost_usd,
    NULL::boolean AS ship_free,
    NULL::int AS ship_days_min,
    NULL::int AS ship_days_max,
    NULL::boolean AS ship_tracking,
    NULL::text AS delivery_date_desc,
    NULL::int AS available_stock,
    NULL::text AS neckline,
    NULL::text AS style,
    NULL::text AS fabric_type,
    NULL::text AS color,
    NULL::text[] AS colors,
    NULL::text[] AS sizes,
    NULL::text AS material,
    NULL::text AS pattern_type,
    NULL::text AS sleeve_style,
    NULL::text AS waistline,
    NULL::text AS season,
    NULL::text AS silhouette,
    NULL::text AS decoration,
    NULL::text AS gender,
    NULL::text AS store_name,
    NULL::numeric AS store_rating,
    s.id AS swypik_seller_id,
    s.name AS swypik_seller_name,
    s.status AS swypik_seller_status,
    NULL::text AS ae_category_id,
    NULL::text AS ae_category_name,
    NULL::text AS ae_category_name_ro,
    NULL::text AS ae_root_category_id,
    NULL::text AS ae_root_category_name,
    NULL::text AS ae_root_category_name_ro
  FROM marketplace_products p
  LEFT JOIN sellers s ON s.id = p.seller_id
`;

type Meta = Record<string, unknown>;

type DetailRow = {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  category: string | null;
  brand: string | null;
  taxonomy_node_slug: string | null;
  supplier_product_id: string | null;
  external_product_id: string | null;
  price_cents: number | null;
  compare_at_price_cents: number | null;
  metadata: unknown;
  updated_at: string;
  ae_internal_id: number | null;
  ae_product_id: string | null;
  ae_title: string | null;
  ae_title_ro: string | null;
  product_type: string | null;
  product_type_ro: string | null;
  ae_brand: string | null;
  min_price_usd: string | null;
  video_url: string | null;
  has_video: boolean | null;
  rating: string | null;
  rating_count: number | null;
  orders_count: number | null;
  ship_method: string | null;
  ship_cost_usd: string | null;
  ship_free: boolean | null;
  ship_days_min: number | null;
  ship_days_max: number | null;
  ship_tracking: boolean | null;
  delivery_date_desc: string | null;
  available_stock: number | null;
  neckline: string | null;
  style: string | null;
  fabric_type: string | null;
  color: string | null;
  colors: string[] | null;
  sizes: string[] | null;
  material: string | null;
  pattern_type: string | null;
  sleeve_style: string | null;
  waistline: string | null;
  season: string | null;
  silhouette: string | null;
  decoration: string | null;
  gender: string | null;
  store_name: string | null;
  store_rating: string | null;
  swypik_seller_id: string | null;
  swypik_seller_name: string | null;
  swypik_seller_status: string | null;
  listing_type?: string | null;
  currency?: string | null;
  ae_category_id: string | null;
  ae_category_name: string | null;
  ae_category_name_ro: string | null;
  ae_root_category_id: string | null;
  ae_root_category_name: string | null;
  ae_root_category_name_ro: string | null;
};

function metadataObject(value: unknown): Meta {
  return value && typeof value === "object" ? (value as Meta) : {};
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function firstBool(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value === "true") return true;
      if (value === "false") return false;
    }
    if (typeof value === "number") return value > 0;
  }
  return false;
}

function cleanCategory(value: unknown, fallback = "General") {
  const label = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!label) return fallback;
  if (/^AE-\d+$/i.test(label)) return fallback;
  if (/^\d{6,}$/.test(label)) return fallback;
  return label;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  return items.length > 0 ? items : null;
}

function buildImages(row: { image_url: string | null }, metadata: Meta) {
  const result: string[] = [];
  if (typeof row.image_url === "string" && row.image_url) result.push(row.image_url);

  const metadataImages = Array.isArray(metadata.images) ? metadata.images : [];
  for (const image of metadataImages) {
    if (typeof image === "string" && image && !result.includes(image)) result.push(image);
  }

  const aeImages = Array.isArray(metadata.ae_images) ? metadata.ae_images : [];
  for (const image of aeImages) {
    if (typeof image === "string" && image && !result.includes(image)) result.push(image);
  }

  return result.slice(0, 8);
}

/** Doar căi interne: un URL extern din metadata nu devine link în pagină. */
function internalCtaUrl(value: string | null | undefined): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

export async function getProductDetail(
  id: string,
  locale: string = "ro",
): Promise<ProductDetail | null> {
  const numericId = Number(id);
  const legacyAeInternalId = Number.isInteger(numericId) && numericId > 0 && numericId < 2147483647 ? numericId : null;
  // A slug must contain at least one non-hex char or hyphen pattern that isn't a UUID.
  // Cheap heuristic: if it's not a UUID and not purely numeric, treat as candidate slug too.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  // Calea fierbinte (link-urile interne folosesc UUID-ul): lookup pe cheia
  // primară. `p.id::text = $1` din interogarea generală anula indexul PK → Seq
  // Scan pe tot catalogul la fiecare pagină de produs (w6-performance, EXPLAIN).
  const byPrimaryKey = isUuid
    ? (await dbQuery<DetailRow>(
        `${DETAIL_SELECT}
          WHERE p.id = $1::uuid AND p.status = 'active' AND p.effective_label = 'safe'
          LIMIT 1`,
        [id],
      )).rows
    : [];

  const { rows } = byPrimaryKey.length > 0 ? { rows: byPrimaryKey } : await dbQuery<DetailRow>(
    `
      ${DETAIL_SELECT}
      WHERE p.status = 'active'
        AND p.effective_label = 'safe'
        AND (
          p.id::text = $1
          OR p.supplier_product_id = $1
          OR p.external_product_id = $1
          OR ($2::bool AND EXISTS (
            SELECT 1 FROM product_translations pt_lookup
             WHERE pt_lookup.product_id = p.id
               AND pt_lookup.slug = $1
          ))
        )
      ORDER BY
        CASE
          WHEN p.id::text = $1 THEN 0
          WHEN p.supplier_product_id = $1 THEN 1
          WHEN p.external_product_id = $1 THEN 2
          ELSE 3
        END
      LIMIT 1
    `,
    [id, !isUuid && legacyAeInternalId === null],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const metadata = metadataObject(row.metadata);
  const attrs = metadataObject(metadata.attributes);
  const shipping = metadataObject(metadata.shipping);
  const store = metadataObject(metadata.store);

  const images = buildImages(row, metadata);

  // Parallelize independent secondary queries (translations, variants, similar, taxonomy path).
  // Was 4 sequential roundtrips → now 1 parallel batch. ~3x latency reduction on product page.
  const similarCategoryIdEarly = String(firstString(metadata.ae_root_category_id, row.ae_root_category_id, metadata.ae_category_id, row.ae_category_id) || "");
  const similarCategoryTextEarly = row.category || null;
  const taxonomyNodeSlugEarly = typeof row.taxonomy_node_slug === "string" && row.taxonomy_node_slug ? row.taxonomy_node_slug : null;

  const [translationResult, variantResult, similarResult, taxonomyPathResult] = await Promise.all([
    dbQuery<{
      locale: string;
      title: string | null;
      description: string | null;
      slug: string | null;
      seo_title: string | null;
      seo_description: string | null;
    }>(
      `SELECT locale, title, description, slug, seo_title, seo_description
         FROM product_translations
        WHERE product_id = $1 AND locale = ANY($2::text[])`,
      [row.id, [locale, "en"]],
    ).catch(() => ({ rows: [] })),
    dbQuery<{
      id: string;
      sku_id: string;
      title: string;
      price_cents: number | null;
      inventory_quantity: number | null;
      attributes: unknown;
      metadata: unknown;
      status: string;
    }>(
      `
        SELECT
          id::text AS id,
          COALESCE(sku, metadata->>'sku_id', external_variant_id, id::text) AS sku_id,
          COALESCE(title, '') AS title,
          price_cents,
          inventory_quantity,
          attributes,
          metadata,
          status
        FROM marketplace_product_variants
        WHERE product_id = $1
          AND status IN ('active', 'out_of_stock')
        ORDER BY
          COALESCE(attributes->>'color', ''),
          COALESCE(attributes->>'size', ''),
          created_at
      `,
      [row.id],
    ),
    dbQuery<DetailRow>(
      `
        ${DETAIL_SELECT}
        WHERE p.status = 'active'
          AND p.is_adult = false
          AND p.id <> $1
          AND (
            ($2 <> '' AND p.metadata->>'ae_root_category_id' = $2)
            OR ($2 <> '' AND p.metadata->>'ae_category_id' = $2)
            OR ($3::text IS NOT NULL AND p.category = $3)
          )
        ORDER BY
          COALESCE(NULLIF(p.metadata->>'orders_count', '')::numeric,
                   NULLIF(p.metadata->>'ae_orders', '')::numeric, 0) DESC,
          COALESCE(NULLIF(p.metadata->>'rating', '')::numeric,
                   NULLIF(p.metadata->>'ae_rating', '')::numeric, 0) DESC,
          p.updated_at DESC
        LIMIT 8
      `,
      [row.id, similarCategoryIdEarly, similarCategoryTextEarly],
    ),
    taxonomyNodeSlugEarly
      ? dbQuery<{ slug: string; label: string }>(
        `WITH RECURSIVE chain AS (
             SELECT slug, parent_slug, 0 AS depth FROM taxonomy_nodes WHERE slug = $1
             UNION ALL
             SELECT n.slug, n.parent_slug, c.depth + 1 FROM taxonomy_nodes n JOIN chain c ON n.slug = c.parent_slug
           )
           SELECT c.slug, COALESCE(t.label, t_en.label, c.slug) AS label
           FROM chain c
           LEFT JOIN taxonomy_translations t ON t.node_slug = c.slug AND t.locale = $2
           LEFT JOIN taxonomy_translations t_en ON t_en.node_slug = c.slug AND t_en.locale = 'en'
           ORDER BY c.depth DESC`,
        [taxonomyNodeSlugEarly, locale],
      ).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);

  // ---- Process translation result ----
  let translation: { title: string; description: string | null; seo_title: string | null; seo_description: string | null; slug: string | null } | null = null;
  const trs = translationResult.rows;
  const preferred = trs.find((r) => r.locale === locale);
  const fallback = trs.find((r) => r.locale === "en");
  const t = preferred ?? fallback;
  if (t) {
    translation = {
      title: String(t.title || ""),
      description: t.description ?? null,
      slug: t.slug ?? null,
      seo_title: t.seo_title ?? null,
      seo_description: t.seo_description ?? null,
    };
  }

  const titleRo = firstString(row.ae_title_ro, metadata.title_ro, row.title);
  const titleEn = firstString(row.ae_title, metadata.title_en, row.title) || row.title;
  const title = (translation?.title
    ? translation.title
    : (locale === "ro" ? (titleRo || titleEn) : (titleEn || titleRo))) as string;

  const category = cleanCategory(
    firstString(
      metadata.product_type_ro,
      row.product_type_ro,
      metadata.product_type,
      row.product_type,
      metadata.ae_category_name_ro,
      row.ae_category_name_ro,
      metadata.ae_category_name,
      row.ae_category_name,
      row.category,
      metadata.ae_root_category_name_ro,
      row.ae_root_category_name_ro,
      metadata.ae_root_category_name,
      row.ae_root_category_name,
    ),
  );

  const categoryId = firstNumber(metadata.ae_category_id, row.ae_category_id, metadata.ae_root_category_id, row.ae_root_category_id);
  const priceCents = firstNumber(row.price_cents, 0) || 0;
  const compareAtCents = firstNumber(row.compare_at_price_cents, 0) || 0;
  // Rating DOAR din recenzii reale (product_reviews, nu cele ascunse). Valorile
  // din metadata (ex. rating 4.9 din seed-ul Fly) sunt inventate — ignorate.
  const { getProductRatingMap } = await import("@/lib/reviews/aggregate");
  const ownRating = (await getProductRatingMap([String(row.id)])).get(String(row.id));
  const rating = ownRating && ownRating.reviewCount > 0 ? Number(ownRating.avgRating.toFixed(2)) : null;
  const ordersCount = firstNumber(metadata.orders_count, row.orders_count);
  const ratingCount = ownRating ? ownRating.reviewCount : 0;
  const storeRating = firstNumber(store.rating, row.store_rating, metadata.store_rating, 0) || 0;
  const hasRealOrders = ordersCount !== null && ordersCount > 0;

  const variantRows = variantResult.rows;
  const colorMap: Record<string, { image: string | null; sizes: Array<{ size: string; price: number; stock: number; skuId: string }> }> = {};
  const variants = variantRows.map((variant) => {
    const variantAttrs = metadataObject(variant.attributes);
    const variantMeta = metadataObject(variant.metadata);
    const color = firstString(variantAttrs.color, variantMeta.color);
    const size = firstString(variantAttrs.size, variantMeta.size);
    const image = firstString(variantAttrs.image_url, variantMeta.image_url);
    const stock = firstNumber(variant.inventory_quantity, 0) || 0;
    const priceRon = (firstNumber(variant.price_cents, priceCents) || priceCents) / 100;
    const skuId = String(variant.sku_id);
    const name = firstString(variant.title, [color, size].filter(Boolean).join(" / "), title) || title;

    if (color) {
      if (!colorMap[color]) {
        colorMap[color] = { image, sizes: [] };
      }
      if (size) {
        colorMap[color].sizes.push({
          size,
          price: priceRon,
          stock,
          skuId,
        });
      }
    }

    return {
      id: String(variant.id),
      skuId,
      name,
      priceRon,
      priceUsd: firstNumber(variantMeta.price_usd, metadata.min_price_usd, row.min_price_usd, 0) || 0,
      image,
      stock,
      color,
      size,
    };
  });

  const similarRows = similarResult.rows;
  const taxonomyPath: Array<{ slug: string; label: string }> = taxonomyPathResult.rows.map((r) => ({
    slug: String(r.slug),
    label: String(r.label),
  }));

  return {
    product: {
      id: String(row.id),
      pgId: firstNumber(row.ae_internal_id),
      aeProductId: String(firstString(row.supplier_product_id, row.external_product_id, row.ae_product_id, row.id) || row.id),
      title,
      titleRo,
      titleEn,
      description: translation?.description ?? row.description,
      seoTitle: translation?.seo_title ?? null,
      seoDescription: translation?.seo_description ?? null,
      localizedSlug: translation?.slug ?? null,
      price: priceCents / 100,
      oldPrice: compareAtCents > 0 ? compareAtCents / 100 : null,
      minPriceUsd: firstNumber(metadata.min_price_usd, row.min_price_usd, 0) || 0,
      images,
      video: firstString(metadata.video_url, row.video_url),
      hasVideo: firstBool(metadata.has_video, row.has_video, false),
      rating: rating !== null && rating > 0 ? rating : null,
      ratingCount,
      ordersCount: hasRealOrders ? ordersCount : null,
      brand: firstString(row.brand, row.ae_brand),
      category,
      categoryId,
      taxonomyNodeSlug: taxonomyNodeSlugEarly,
      taxonomyPath,
      shipMethod: firstString(shipping.method, row.ship_method),
      shipCostUsd: firstNumber(shipping.cost_usd, row.ship_cost_usd, 0) || 0,
      shipFree: firstBool(shipping.free, row.ship_free, false),
      shipDaysMin: firstNumber(shipping.days_min, row.ship_days_min),
      shipDaysMax: firstNumber(shipping.days_max, row.ship_days_max),
      shipTracking: firstBool(shipping.tracking, row.ship_tracking, false),
      deliveryDate: firstString(shipping.delivery_date_desc, row.delivery_date_desc),
      availableStock: firstNumber(metadata.available_stock, row.available_stock),
      color: firstString(attrs.color, row.color),
      colors: asStringArray(attrs.colors) || asStringArray(row.colors),
      sizes: asStringArray(attrs.sizes) || asStringArray(row.sizes),
      neckline: firstString(attrs.neckline, row.neckline),
      style: firstString(attrs.style, row.style),
      fabricType: firstString(attrs.fabric_type, row.fabric_type),
      material: firstString(attrs.material, row.material),
      patternType: firstString(attrs.pattern_type, row.pattern_type),
      sleeveStyle: firstString(attrs.sleeve_style, row.sleeve_style),
      waistline: firstString(attrs.waistline, row.waistline),
      season: firstString(attrs.season, row.season),
      silhouette: firstString(attrs.silhouette, row.silhouette),
      decoration: asStringArray(attrs.decoration) || asStringArray(row.decoration),
      gender: firstString(attrs.gender, row.gender),
      storeName: firstString(store.name, row.store_name),
      storeRating,
      isEstimatedSocial: !hasRealOrders,
      listingType: typeof row.listing_type === "string" && row.listing_type ? row.listing_type : "product",
      currency: String(row.currency || "RON").trim().toUpperCase(),
      ctaUrl: internalCtaUrl(firstString(metadata.cta_url)),
      seller:
        row.swypik_seller_id && row.swypik_seller_status === "active"
          ? { id: String(row.swypik_seller_id), name: String(row.swypik_seller_name || "Vânzător Swypik") }
          : null,
    },
    variants,
    colorMap,
    similar: (await (async () => {
      const { getProductRatingMap } = await import("@/lib/reviews/aggregate");
      const ids = similarRows.map((r) => String(r.id));
      const ratingMap = ids.length ? await getProductRatingMap(ids) : new Map();
      return similarRows
        .map((similarRow) => {
          const similarMetadata = metadataObject(similarRow.metadata);
          const similarPriceCents = firstNumber(similarRow.price_cents, 0) || 0;
          const similarCompareAtCents = firstNumber(similarRow.compare_at_price_cents, 0) || 0;
          const agg = ratingMap.get(String(similarRow.id));
          return {
            id: String(firstNumber(similarRow.ae_internal_id) || similarRow.id),
            title: String(firstString(similarRow.ae_title_ro, similarMetadata.title_ro, similarRow.title) || similarRow.title),
            price: similarPriceCents / 100,
            // ANPC: fara pret de referinta fabricat — doar compare_at real din DB.
            oldPrice: similarCompareAtCents > 0 ? similarCompareAtCents / 100 : undefined,
            image: String(firstString(similarRow.image_url, ...(Array.isArray(similarMetadata.images) ? similarMetadata.images : [])) || ""),
            hasVideo: firstBool(similarMetadata.has_video, similarRow.has_video, false),
            rating: agg && agg.reviewCount > 0 ? Number(agg.avgRating.toFixed(2)) : 0,
            ratingAvg: agg && agg.reviewCount > 0 ? Number(agg.avgRating.toFixed(2)) : null,
            ratingCount: agg ? agg.reviewCount : 0,
          };
        })
        .filter((item) => item.image);
    })()),
  };
}
