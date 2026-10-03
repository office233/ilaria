import { dbQuery } from "@/lib/db";
import { parseScopedTagFilter } from "@/lib/db/category-filter-utils";
import { UUID_RE } from "@/lib/validation/uuid";
import { logger } from "@/lib/logger";
import { mediaPublicBaseUrl } from "@/lib/storage/config";
import { getProductRatingMap } from "@/lib/reviews/aggregate";

export type ProductFilters = {
  search?: string;
  category?: string;
  categoryId?: string;
  taxonomyNodeSlug?: string;
  tag?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: "price_asc" | "price_desc" | "popular" | "newest" | "discount";
  mode?: "trending" | "feed" | "deals" | "default" | "video" | "bestvalue" | "toprated";
  limit?: number;
  offset?: number;
  excludeIds?: string[];
  seed?: number;
  locale?: string;
  includeCount?: boolean;
};

const BASE_PRODUCT_SELECT = `
  FROM marketplace_products p
  LEFT JOIN LATERAL (
    SELECT
      v.id AS linked_video_id,
      v.playback_url AS linked_video_playback_url,
      v.thumbnail_url AS linked_video_thumbnail_url,
      va.object_key AS linked_video_source_key
    FROM video_product_links vpl
    JOIN videos v ON v.id = vpl.video_id
    LEFT JOIN LATERAL (
      SELECT object_key
      FROM video_assets
      WHERE video_id = v.id AND asset_type = 'source'
      ORDER BY created_at DESC
      LIMIT 1
    ) va ON true
    WHERE vpl.product_id = p.id
      AND v.status = 'ready'
      AND v.visibility = 'public'
      AND COALESCE(v.is_hidden, false) = false
    ORDER BY v.created_at DESC
    LIMIT 1
  ) linked_video ON true
`;

type ProductMetadata = Record<string, unknown>;

type ProductRow = {
  id: string;
  price_cents: number | null;
  compare_at_price_cents: number | null;
  metadata: ProductMetadata | null;
  title: string;
  description: string | null;
  image_url: string | null;
  category: string | null;
  brand: string | null;
  taxonomy_node_slug: string | null;
  supplier_product_id: string | null;
  external_product_id: string | null;
  created_at: string;
  updated_at: string;
  ae_internal_id: number | null;
  ae_product_id: string | null;
  ae_title: string | null;
  ae_title_ro: string | null;
  ae_product_type: string | null;
  ae_product_type_ro: string | null;
  ae_orders_count: number | null;
  ae_rating: string | null;
  ae_ship_days_min: number | null;
  ae_ship_days_max: number | null;
  ae_ship_cost_usd: string | null;
  ae_ship_free: boolean | null;
  ae_video_url: string | null;
  ae_has_video: boolean | null;
  ae_store_name: string | null;
  linked_video_id: string | null;
  linked_video_playback_url: string | null;
  linked_video_thumbnail_url: string | null;
  linked_video_source_key: string | null;
  ae_category_id: string | null;
  ae_category_name: string | null;
  ae_category_name_ro: string | null;
  ae_root_id: string | null;
  ae_root_name: string | null;
  ae_root_name_ro: string | null;
};

const BASE_PRODUCT_COLUMNS = `
  SELECT
    p.id,
    p.price_cents,
    p.compare_at_price_cents,
    p.metadata,
    p.title,
    p.description,
    p.image_url,
    p.category,
    p.brand,
    p.taxonomy_node_slug,
    p.supplier_product_id,
    p.external_product_id,
    p.created_at,
    p.updated_at,
    NULL::int AS ae_internal_id,
    NULL::text AS ae_product_id,
    NULL::text AS ae_title,
    NULL::text AS ae_title_ro,
    NULL::text AS ae_product_type,
    NULL::text AS ae_product_type_ro,
    NULL::int AS ae_orders_count,
    NULL::numeric AS ae_rating,
    NULL::int AS ae_ship_days_min,
    NULL::int AS ae_ship_days_max,
    NULL::numeric AS ae_ship_cost_usd,
    NULL::boolean AS ae_ship_free,
    NULL::text AS ae_video_url,
    NULL::boolean AS ae_has_video,
    NULL::text AS ae_store_name,
    linked_video.linked_video_id AS linked_video_id,
    linked_video.linked_video_playback_url AS linked_video_playback_url,
    linked_video.linked_video_thumbnail_url AS linked_video_thumbnail_url,
    linked_video.linked_video_source_key AS linked_video_source_key,
    NULL::text AS ae_category_id,
    NULL::text AS ae_category_name,
    NULL::text AS ae_category_name_ro,
    NULL::text AS ae_root_id,
    NULL::text AS ae_root_name,
    NULL::text AS ae_root_name_ro
`;

// FIX 2026-07-29: coloanele `orders_count_int` si `rating_numeric` NU EXISTA in
// tabela marketplace_products ⇒ ORICE query de listare crapa cu
// "column p.orders_count_int does not exist" (42703) si toata pagina principala
// (trending / deals / bestvalue / toprated / feed) returna HTTP 500.
// Valorile traiesc in `metadata` JSONB, ca restul campurilor derivate (vezi
// VIDEO_SQL mai jos). Citim de acolo, cu fallback pe 0.
const ORDERS_SQL = `COALESCE(
  NULLIF(p.metadata->>'orders_count', '')::numeric,
  NULLIF(p.metadata->>'ae_orders', '')::numeric,
  0
)`;
const RATING_SQL = `COALESCE(
  NULLIF(p.metadata->>'rating', '')::numeric,
  NULLIF(p.metadata->>'ae_rating', '')::numeric,
  0
)`;
const VIDEO_SQL = `(
  COALESCE((p.metadata->>'has_video')::boolean, false)
  OR NULLIF(p.metadata->>'ae_video_url', '') IS NOT NULL
  OR CASE
    WHEN jsonb_typeof(p.metadata->'videos') = 'array' THEN jsonb_array_length(p.metadata->'videos') > 0
    ELSE false
  END
  OR EXISTS (
    SELECT 1
    FROM video_product_links vpl
    JOIN videos v ON v.id = vpl.video_id
    WHERE vpl.product_id = p.id
      AND v.status = 'ready'
      AND v.visibility = 'public'
      AND COALESCE(v.is_hidden, false) = false
  )
)`;
const DISCOUNT_SQL = `GREATEST(COALESCE(p.compare_at_price_cents, 0) - COALESCE(p.price_cents, 0), 0)`;
const ROOT_CATEGORY_ID_SQL = `COALESCE(NULLIF(p.metadata->>'ae_root_category_id', ''), NULLIF(p.metadata->>'ae_category_id', ''), '')`;
const ACTUAL_ROOT_CATEGORY_ID_SQL = `COALESCE(NULLIF(p.metadata->>'ae_root_category_id', ''), '')`;
const PRODUCT_TYPE_SQL = `NULLIF(p.metadata->>'product_type', '')`;

function cleanCategoryLabel(value: unknown, fallback = "General") {
  const label = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!label) return fallback;
  if (/^AE-\d+$/i.test(label)) return fallback;
  if (/^\d{6,}$/.test(label)) return fallback;
  return label;
}

// Rejects category candidates that are obviously product titles or raw AE blobs.
// A label longer than 80 chars, equal to / prefix of the title, or containing the
// title as a breadcrumb tail is treated as garbage and replaced with the fallback.
function safeCategoryLabel(value: unknown, title: string | undefined, fallback = "General") {
  const cleaned = cleanCategoryLabel(value, fallback);
  if (cleaned === fallback) return fallback;
  if (cleaned.length > 80) return fallback;
  const t = (title || "").trim().toLowerCase();
  if (!t) return cleaned;
  const l = cleaned.toLowerCase();
  if (l === t) return fallback;
  const titlePrefix = t.slice(0, 30);
  if (titlePrefix.length >= 12 && l.includes(titlePrefix)) {
    // Try to recover the breadcrumb portion before the title slipped in.
    if (cleaned.includes(" > ")) {
      const head = cleaned.split(" > ").filter((p) => {
        const pl = p.toLowerCase();
        return pl && !pl.includes(titlePrefix);
      });
      if (head.length > 0) return head.join(" > ").slice(0, 80);
    }
    return fallback;
  }
  return cleaned;
}

export type TaxonomyLabels = {
  department?: string;
  category?: string;
  subcategory?: string;
  leaf?: string;
};

// One query per request resolves every distinct taxonomy_node_slug found in the
// result set to its localized department/category/subcategory labels. Falls back
// to English when the requested locale has no translation row.
export async function resolveTaxonomyLabels(slugs: string[], locale = "ro"): Promise<Map<string, TaxonomyLabels>> {
  const unique = Array.from(new Set(slugs.filter((s) => typeof s === "string" && s.length > 0)));
  if (unique.length === 0) return new Map();
  const { rows } = await dbQuery<{ leaf_slug: string; node_slug: string; kind: string; label: string }>(
    `
      WITH RECURSIVE leaves AS (
        SELECT s AS leaf_slug FROM unnest($1::text[]) AS t(s)
      ),
      chain AS (
        SELECT l.leaf_slug, n.slug AS node_slug, n.parent_slug, n.kind, 0 AS depth
        FROM leaves l JOIN taxonomy_nodes n ON n.slug = l.leaf_slug
        UNION ALL
        SELECT c.leaf_slug, n.slug, n.parent_slug, n.kind, c.depth + 1
        FROM chain c JOIN taxonomy_nodes n ON n.slug = c.parent_slug
        WHERE c.depth < 8
      )
      SELECT c.leaf_slug, c.node_slug, c.kind,
             COALESCE(tl.label, te.label, c.node_slug) AS label
      FROM chain c
      LEFT JOIN taxonomy_translations tl ON tl.node_slug = c.node_slug AND tl.locale = $2
      LEFT JOIN taxonomy_translations te ON te.node_slug = c.node_slug AND te.locale = 'en'
    `,
    [unique, locale],
  );
  const map = new Map<string, TaxonomyLabels>();
  for (const row of rows) {
    const entry = map.get(row.leaf_slug) || {};
    const label = String(row.label || "").trim();
    if (!label) continue;
    const kind = String(row.kind || "");
    if (kind === "department" && !entry.department) entry.department = label;
    else if (kind === "category" && !entry.category) entry.category = label;
    else if (kind === "subcategory" && !entry.subcategory) entry.subcategory = label;
    else if (kind === "leaf" && !entry.leaf) entry.leaf = label;
    else if (kind === "product_type" && !entry.leaf) entry.leaf = label;
    map.set(row.leaf_slug, entry);
  }
  return map;
}

function firstNonEmpty(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return undefined;
}

function toNumber(...values: unknown[]) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

function toBoolean(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value === "true") return true;
      if (value === "false") return false;
    }
    if (typeof value === "number") return value > 0;
  }
  return undefined;
}

function getMetadataValue(metadata: ProductMetadata, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, metadata);
}

function buildImages(row: { image_url: string | null }, metadata: ProductMetadata) {
  const images: string[] = [];
  if (row.image_url) images.push(row.image_url);
  const extraImages = Array.isArray(metadata?.images) ? metadata.images : [];
  for (const image of extraImages) {
    if (typeof image === "string" && image && image !== row.image_url) {
      images.push(image);
    }
  }
  return images.slice(0, 6);
}

function firstMetadataVideoUrl(metadata: ProductMetadata) {
  const direct = firstNonEmpty(
    metadata.video_url,
    metadata.ae_video_url,
    getMetadataValue(metadata, "video.url"),
    getMetadataValue(metadata, "video.play_url"),
  );
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const videos = Array.isArray(metadata?.videos) ? metadata.videos : [];
  for (const entry of videos) {
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const url = firstNonEmpty(
        rec.url,
        rec.video_url,
        rec.play_url,
        rec.media_url,
      );
      if (typeof url === "string" && url.trim()) return url.trim();
    }
  }

  return undefined;
}

function chooseLocalizedLabel(
  locale: string,
  roCandidates: unknown[],
  enCandidates: unknown[],
  fallback = "General",
) {
  const selected = locale === "ro" ? firstNonEmpty(...roCandidates) : firstNonEmpty(...enCandidates);
  return cleanCategoryLabel(selected, fallback);
}

export type ProductTranslation = {
  title: string;
  description: string | null;
  slug: string | null;
  seo_title: string | null;
  seo_description: string | null;
};

// Bulk-load product_translations for a set of ids and a locale.
// Falls back to 'en' row when the requested locale row is missing.
export async function loadProductTranslations(
  ids: string[],
  locale: string,
): Promise<Map<string, ProductTranslation>> {
  const out = new Map<string, ProductTranslation>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return out;
  const { rows } = await dbQuery<{
    product_id: string;
    locale: string;
    title: string | null;
    description: string | null;
    slug: string | null;
    seo_title: string | null;
    seo_description: string | null;
  }>(
    `SELECT product_id, locale, title, description, slug, seo_title, seo_description
       FROM product_translations
      WHERE product_id = ANY($1::uuid[]) AND locale = ANY($2::text[])`,
    [unique, [locale, "en"]],
  );
  const preferred = new Map<string, (typeof rows)[number]>();
  const fallback = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.locale === locale) preferred.set(String(r.product_id), r);
    else fallback.set(String(r.product_id), r);
  }
  for (const id of unique) {
    const r = preferred.get(id) ?? fallback.get(id);
    if (!r) continue;
    out.set(id, {
      title: String(r.title || ""),
      description: r.description ?? null,
      slug: r.slug ?? null,
      seo_title: r.seo_title ?? null,
      seo_description: r.seo_description ?? null,
    });
  }
  return out;
}

/** Completeaza rating-ul DOAR din recenzii reale (product_reviews, neascunse). */
async function applyReviewRatings<T extends { id: string; rating: number }>(products: T[]): Promise<T[]> {
  if (products.length === 0) return products;
  const ratingMap = await getProductRatingMap(products.map((p) => p.id));
  return products.map((p) => {
    const agg = ratingMap.get(p.id);
    return agg && agg.reviewCount > 0 ? { ...p, rating: Number(agg.avgRating.toFixed(1)) } : p;
  });
}

function transformProduct(
  row: ProductRow,
  locale = "ro",
  taxonomyMap?: Map<string, TaxonomyLabels>,
  translationsMap?: Map<string, ProductTranslation>,
) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const rawPriceCents = Number(row.price_cents);
  const hasValidPrice = Number.isFinite(rawPriceCents) && rawPriceCents > 0;
  // FIX 2026-07-31: nu mai inventam pret. Produsele fara pret primeau 29 RON
  // si puteau fi cumparate la acest pret fictiv. Acum raman 0 si sunt
  // filtrate din listari (hasValidPrice) / afisate ca "pret indisponibil".
  const price = hasValidPrice ? rawPriceCents / 100 : 0;
  const oldPriceCents = Number(row.compare_at_price_cents) || 0;
  // FIX 2026-07-31: pretul vechi era fabricat (price * 1.5) => reducere falsa
  // afisata pe produse care nu au fost niciodata mai scumpe. Practica
  // sanctionabila (OUG 34/2014, Directiva Omnibus). Acum: doar pret real.
  const oldPrice = oldPriceCents > 0 ? oldPriceCents / 100 : 0;
  const discountPercent = oldPrice > price ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0;

  const tr = translationsMap?.get(String(row.id));
  const title = tr?.title
    ? tr.title
    : (locale === "ro"
      ? String(firstNonEmpty(row.ae_title_ro, metadata.title_ro, row.title) || row.title)
      : String(firstNonEmpty(row.ae_title, metadata.title_en, row.title) || row.title));

  // Prefer taxonomy_nodes labels (curated, localized) over raw catalog text
  // which often contains the product title in category fields.
  const taxLabels: TaxonomyLabels = (taxonomyMap && row.taxonomy_node_slug)
    ? (taxonomyMap.get(String(row.taxonomy_node_slug)) || {})
    : {};

  const rootCategoryRaw = taxLabels.department
    || taxLabels.category
    || chooseLocalizedLabel(
      locale,
      [metadata.ae_root_category_name_ro, row.ae_root_name_ro, metadata.ae_root_category_name],
      [metadata.ae_root_category_name, row.ae_root_name, metadata.ae_root_category_name_ro],
    );
  const rootCategory = safeCategoryLabel(rootCategoryRaw, title, "General");

  const leafCategoryRaw = taxLabels.leaf
    || taxLabels.subcategory
    || taxLabels.category
    || chooseLocalizedLabel(
      locale,
      [metadata.ae_category_name_ro, row.ae_category_name_ro, metadata.ae_category_name],
      [metadata.ae_category_name, row.ae_category_name, metadata.ae_category_name_ro],
      rootCategory,
    );
  const leafCategory = safeCategoryLabel(leafCategoryRaw, title, rootCategory);

  const productTypeRaw = taxLabels.subcategory
    || taxLabels.leaf
    || taxLabels.category
    || chooseLocalizedLabel(
      locale,
      [metadata.product_type_ro, row.ae_product_type_ro, metadata.product_type, row.ae_product_type],
      [metadata.product_type, row.ae_product_type, metadata.product_type_ro, row.ae_product_type_ro],
      leafCategory,
    );
  const productType = safeCategoryLabel(productTypeRaw, title, leafCategory);

  const category = safeCategoryLabel(firstNonEmpty(taxLabels.leaf, taxLabels.subcategory, productType, leafCategory, rootCategory), title, rootCategory);
  const categoryId = toNumber(metadata.ae_category_id, row.ae_category_id, metadata.ae_root_category_id, row.ae_root_id);
  const orders = toNumber(metadata.orders_count, row.ae_orders_count, 0) || 0;
  // Rating-ul NU mai vine din metadata (seed-ul Fly punea 4.9 inventat). 0 =
  // fara rating; valoarea reala e completata din product_reviews de
  // applyReviewRatings() dupa transformare. UI-ul ascunde stelele la 0.
  const rating = 0;
  // Zile de livrare: doar valoarea reala din date (0 = necunoscut, UI-ul o
  // ascunde) — nu mai inventam un default de 7 zile.
  const deliveryDays = toNumber(
    getMetadataValue(metadata, "shipping.days_min"),
    metadata.ship_days_min,
    row.ae_ship_days_min,
    0,
  ) || 0;
  const images = buildImages(row, metadata);
  const vendor = String(
    firstNonEmpty(
      getMetadataValue(metadata, "store.name"),
      metadata.store_name,
      row.ae_store_name,
      row.brand,
      "Swypik",
    ) || "Swypik",
  );
  const shipCostUsd = toNumber(
    getMetadataValue(metadata, "shipping.cost_usd"),
    metadata.ship_cost_usd,
    row.ae_ship_cost_usd,
    0,
  ) || 0;
  const shipFree = toBoolean(
    getMetadataValue(metadata, "shipping.free"),
    metadata.ship_free,
    row.ae_ship_free,
    shipCostUsd === 0,
  ) || false;
  const publicUrl = mediaPublicBaseUrl();
  const linkedSourceUrl = row.linked_video_source_key && publicUrl
    ? `${publicUrl}/${row.linked_video_source_key}`
    : undefined;
  const video = firstNonEmpty(firstMetadataVideoUrl(metadata), row.ae_video_url, linkedSourceUrl, row.linked_video_playback_url);
  const hasVideo = toBoolean(metadata.has_video, row.ae_has_video, Boolean(video || row.linked_video_id)) || false;

  return {
    id: String(row.id),
    pgId: toNumber(row.ae_internal_id),
    aeProductId: String(firstNonEmpty(row.supplier_product_id, row.external_product_id, row.ae_product_id, row.id)),
    title,
    titleEn: String(firstNonEmpty(row.ae_title, row.title, title) || title),
    description: row.description ? row.description.replace(/<[^>]*>/g, " ").trim().substring(0, 200) : title,
    // Fara beneficii/insigne generice fabricate ("Livrare rapida", "Produs verificat").
    benefits: [] as string[],
    whyBuy: "",
    warnings: [] as string[],
    price,
    oldPrice,
    discountPercent,
    costUsd: shipCostUsd,
    rating,
    orders,
    deliveryDays,
    hasValidPrice,
    images,
    video: typeof video === "string" ? video : undefined,
    videoId: row.linked_video_id ? String(row.linked_video_id) : undefined,
    videoThumbnail: typeof row.linked_video_thumbnail_url === "string" ? row.linked_video_thumbnail_url : undefined,
    hasVideo,
    category,
    categoryId,
    taxonomyNodeSlug: typeof row.taxonomy_node_slug === "string" ? row.taxonomy_node_slug : null,
    productType,
    rootCategory,
    vendor,
    tags: [productType, leafCategory, rootCategory].filter(Boolean).join(", "),
    gradient: "from-orange-500 to-pink-500",
    // Scor neutru (nu mai derivam un "quality score" din rating-uri inventate).
    qualityScore: 7,
    shipFree,
    shipDaysMin: toNumber(getMetadataValue(metadata, "shipping.days_min"), metadata.ship_days_min, row.ae_ship_days_min),
    shipDaysMax: toNumber(getMetadataValue(metadata, "shipping.days_max"), metadata.ship_days_max, row.ae_ship_days_max),
    socialProofLabel: orders > 500 ? `${orders}+ comenzi` : orders > 100 ? `${orders}+ vandute` : orders > 10 ? "Popular" : undefined,
    commerceBadge: orders > 500 ? "Se vinde bine" : discountPercent >= 30 ? "Super reducere" : undefined,
    dealLabel: discountPercent >= 20 ? "Super Deal" : discountPercent >= 10 ? "Pret bun" : "Nou",
  };
}

const CATEGORY_TEXT_EXPRESSIONS = [
  "p.taxonomy_department",
  "p.taxonomy_category",
  "p.taxonomy_subcategory",
  "p.taxonomy_leaf",
  "p.taxonomy_slug",
  "p.canonical_category",
  "p.canonical_category_slug",
  "p.metadata->>'product_type'",
  "p.metadata->>'product_type_ro'",
  "p.category",
  "p.metadata->>'ae_category_name'",
  "p.metadata->>'ae_category_name_ro'",
  "p.metadata->>'ae_root_category_name'",
  "p.metadata->>'ae_root_category_name_ro'",
];

function buildCategoryTextCondition(paramRef: string) {
  return `(${CATEGORY_TEXT_EXPRESSIONS
    .map((expression) => `COALESCE(NULLIF(${expression}, ''), '') ILIKE ${paramRef}`)
    .join(" OR ")})`;
}

function buildSyntheticRootCondition(rootType: string) {
  const withOptionalProductTypeFallback = (rootId: string, productTypes: string[]) => {
    const productTypeList = productTypes.map((type) => `'${type.replace(/'/g, "''")}'`).join(", ");
    return `(${ACTUAL_ROOT_CATEGORY_ID_SQL} = '${rootId}' OR (${ACTUAL_ROOT_CATEGORY_ID_SQL} = '' AND ${PRODUCT_TYPE_SQL} IN (${productTypeList})))`;
  };

  const withoutKnownRoot = (productTypes: string[]) => {
    const productTypeList = productTypes.map((type) => `'${type.replace(/'/g, "''")}'`).join(", ");
    return `(${ACTUAL_ROOT_CATEGORY_ID_SQL} = '' AND ${PRODUCT_TYPE_SQL} IN (${productTypeList}))`;
  };

  if (rootType === "apparel") {
    return withOptionalProductTypeFallback("200000343", ['Socks', 'Boxer Briefs', 'Tank Tops', 'T-Shirts', 'Polo Shirts', 'Casual Shirts', 'Dress Shirts', 'Hawaiian Shirts', 'Hoodies', 'Sweatshirts', 'Sweaters', 'Cardigans', 'Jackets', 'Coats', 'Vests', 'Blazers', 'Suits', 'Casual Pants', 'Jeans', 'Cargo Pants', 'Shorts', 'Board Shorts', 'Sweatpants', 'Pajamas', 'Tracksuits', 'Sleeveless Tops', 'Thermal Underwear', 'Compression Wear', 'Swimwear', 'Robes', 'Activewear']);
  }
  if (rootType === "womens") {
    return withOptionalProductTypeFallback("200000345", ['Panties', 'Leggings', 'Dresses', 'Skirts', 'Blouses', 'Bras', 'Tights & Hosiery', 'Bodysuits', 'Vintage Dresses', 'Shirt Dresses']);
  }
  if (rootType === "accessories") {
    return withoutKnownRoot(['Hats & Caps', 'Scarves', 'Gloves', 'Belts', 'Ties', 'Bags', 'Jewelry', 'Watches', 'Shoes']);
  }
  if (rootType === "sports") {
    return withOptionalProductTypeFallback("18", ['Sports Gear', 'Sports Protection']);
  }
  if (rootType === "underwear") {
    return `${ACTUAL_ROOT_CATEGORY_ID_SQL} = '200574005'`;
  }
  if (rootType === "other") {
    return null;
  }
  return null;
}

const TAXONOMY_PATH_COLUMNS = [
  "p.taxonomy_department",
  "p.taxonomy_category",
  "p.taxonomy_subcategory",
];
const TAXONOMY_PATH_DEFAULTS = ["other", "general", "general"] as const;

function buildTaxonomyPathFilters(where: string[], params: unknown[], paramIndex: number, categoryId: string) {
  const parts = categoryId
    .replace("department:", "")
    .split(":")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, TAXONOMY_PATH_COLUMNS.length);

  for (const [index, part] of parts.entries()) {
    // Aceleași valori implicite ca ierarhia de rezervă (Other › General › General),
    // altfel produsele fără taxonomie apar în „Altele” dar filtrul nu le găsește.
    const fallback = TAXONOMY_PATH_DEFAULTS[index];
    where.push(`REGEXP_REPLACE(LOWER(COALESCE(NULLIF(${TAXONOMY_PATH_COLUMNS[index]}, ''), '${fallback}')), '[^a-z0-9]+', '-', 'g') = $${paramIndex}`);
    params.push(part);
    paramIndex += 1;
  }
  return paramIndex;
}

function addCategoryTextFilters(where: string[], params: unknown[], paramIndex: number, value: string) {
  const scoped = parseScopedTagFilter(value);
  const terms = scoped.tags.length > 0
    ? scoped.tags
    : value.split("|").map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) return paramIndex;

  const conditions = terms.map((term, index) => {
    const pIdx = paramIndex + index;
    params.push(`%${term}%`);
    return buildCategoryTextCondition(`$${pIdx}`);
  });

  where.push(`(${conditions.join(" OR ")})`);
  paramIndex += terms.length;

  const syntheticRootConditions = scoped.rootIds
    .filter((rootId) => rootId.startsWith("root:"))
    .map((rootId) => buildSyntheticRootCondition(rootId.replace("root:", "")))
    .filter(Boolean);

  if (syntheticRootConditions.length > 0) {
    where.push(`(${syntheticRootConditions.join(" OR ")})`);
  }

  const numericRootIds = scoped.rootIds.filter((rootId) => !rootId.startsWith("root:"));
  if (numericRootIds.length > 0) {
    const placeholders = numericRootIds.map((_, index) => `$${paramIndex + index}`).join(", ");
    where.push(`${ROOT_CATEGORY_ID_SQL} IN (${placeholders})`);
    params.push(...numericRootIds);
    paramIndex += numericRootIds.length;
  }

  return paramIndex;
}

export function buildSearchFilters(filters: ProductFilters) {
  const {
    search,
    category,
    categoryId,
    taxonomyNodeSlug,
    tag,
    minPrice,
    maxPrice,
    mode,
    excludeIds,
    locale,
  } = filters;

  // FIX 2026-07-31: excludem produsele fara pret valid direct din SQL —
  // inainte primeau pretul fictiv de 29 RON si apareau in toate listarile.
  const where = [
    "p.status = 'active'",
    "COALESCE(p.is_adult, false) = false",
    "p.effective_label = 'safe'",
    "COALESCE(p.price_cents, 0) > 0",
  ];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (search) {
    const effLocale = (locale || "ro").toLowerCase();
    where.push(`
      (
        p.search_document @@ websearch_to_tsquery('simple', $${paramIndex})
        OR EXISTS (
          SELECT 1 FROM product_translations pt_s
           WHERE pt_s.product_id = p.id
             AND pt_s.locale = $${paramIndex + 2}
             AND pt_s.search_document @@ websearch_to_tsquery('simple', $${paramIndex})
        )
        OR p.title ILIKE $${paramIndex + 1}
        OR COALESCE(p.category, '') ILIKE $${paramIndex + 1}
        OR COALESCE(p.metadata->>'ae_category_name', '') ILIKE $${paramIndex + 1}
        OR COALESCE(p.metadata->>'ae_category_name_ro', '') ILIKE $${paramIndex + 1}
        OR COALESCE(p.metadata->>'product_type', '') ILIKE $${paramIndex + 1}
        OR COALESCE(p.metadata->>'product_type_ro', '') ILIKE $${paramIndex + 1}
        OR p.taxonomy_node_slug IN (
          WITH RECURSIVE matched AS (
            SELECT DISTINCT tt.node_slug AS slug
              FROM taxonomy_translations tt
             WHERE tt.locale IN ('ro','de','fr','en')
               AND char_length(public.f_unaccent(lower($${paramIndex}))) >= 3
               AND (
                 public.f_unaccent(lower(tt.label)) LIKE public.f_unaccent(lower($${paramIndex})) || '%'
                 OR public.f_unaccent(lower($${paramIndex})) LIKE public.f_unaccent(lower(tt.label)) || '%'
                 OR word_similarity(public.f_unaccent(lower($${paramIndex})), public.f_unaccent(lower(tt.label))) > 0.7
               )
          ), descendants AS (
            SELECT slug FROM matched
            UNION ALL
            SELECT n.slug FROM taxonomy_nodes n
            JOIN descendants d ON n.parent_slug = d.slug
          )
          SELECT slug FROM descendants
        )
      )
    `);
    params.push(search, `%${search}%`, effLocale);
    paramIndex += 3;
  }

  if (category) {
    paramIndex = addCategoryTextFilters(where, params, paramIndex, category);
  }

  if (categoryId) {
    if (String(categoryId).startsWith("root:")) {
      const rootType = String(categoryId).replace("root:", "");
      const rootCondition = buildSyntheticRootCondition(rootType);
      if (rootCondition) where.push(rootCondition);
    } else if (String(categoryId).startsWith("department:")) {
      paramIndex = buildTaxonomyPathFilters(where, params, paramIndex, String(categoryId));
    } else if (String(categoryId).startsWith("tag:")) {
      const tagValue = String(categoryId).replace("tag:", "");
      paramIndex = addCategoryTextFilters(where, params, paramIndex, tagValue);
    } else {
      // Support both clean taxonomy slugs and legacy numeric category ids.
      where.push(`
        (
          COALESCE(p.taxonomy_slug, '') = $${paramIndex}
          OR COALESCE(p.canonical_category_slug, '') = $${paramIndex}
          OR COALESCE(p.taxonomy_leaf, '') = $${paramIndex}
          OR COALESCE(p.taxonomy_subcategory, '') = $${paramIndex}
          OR COALESCE(p.taxonomy_category, '') = $${paramIndex}
          OR COALESCE(p.metadata->>'ae_category_id', '') = $${paramIndex}
          OR COALESCE(p.metadata->>'ae_parent_category_id', '') = $${paramIndex}
          OR COALESCE(p.metadata->>'ae_root_category_id', '') = $${paramIndex}
          OR p.taxonomy_node_slug IN (
            WITH RECURSIVE descendants AS (
              SELECT slug FROM taxonomy_nodes WHERE slug = $${paramIndex}::text
              UNION ALL
              SELECT n.slug FROM taxonomy_nodes n JOIN descendants d ON n.parent_slug = d.slug
            )
            SELECT slug FROM descendants
          )
        )
      `);
      params.push(String(categoryId));
      paramIndex += 1;
    }
  }

  if (taxonomyNodeSlug) {
    where.push(`
      p.taxonomy_node_slug IN (
        WITH RECURSIVE descendants AS (
          SELECT slug FROM taxonomy_nodes WHERE slug = $${paramIndex}::text
          UNION ALL
          SELECT n.slug FROM taxonomy_nodes n
          JOIN descendants d ON n.parent_slug = d.slug
        )
        SELECT slug FROM descendants
      )
    `);
    params.push(String(taxonomyNodeSlug));
    paramIndex += 1;
  }

  if (tag) {
    paramIndex = addCategoryTextFilters(where, params, paramIndex, tag);
  }

  if (minPrice != null) {
    where.push(`p.price_cents >= $${paramIndex}`);
    params.push(Math.round(minPrice * 100));
    paramIndex += 1;
  }

  if (maxPrice != null) {
    where.push(`p.price_cents <= $${paramIndex}`);
    params.push(Math.round(maxPrice * 100));
    paramIndex += 1;
  }

  if (mode === "video") {
    where.push(VIDEO_SQL);
  }

  if (excludeIds?.length) {
    const placeholders = excludeIds.map((_, index) => `$${paramIndex + index}`).join(",");
    where.push(`p.id::text NOT IN (${placeholders})`);
    params.push(...excludeIds);
    paramIndex += excludeIds.length;
  }

  return { where, params, paramIndex };
}

function buildOrderBy(sort?: ProductFilters["sort"], mode?: ProductFilters["mode"], search?: string) {
  // When user searches with a free-text query, prefix the ORDER BY with a
  // taxonomy-slug-match priority so products in a category that matches the
  // query label come first. This avoids "rochii" returning slimming devices
  // (matched only by description text).
  const slugBoost = search
    ? `CASE WHEN p.taxonomy_node_slug IN (
        WITH RECURSIVE matched AS (
          SELECT DISTINCT tt.node_slug AS slug FROM taxonomy_translations tt
           WHERE tt.locale IN ('ro','de','fr','en')
             AND char_length(public.f_unaccent(lower($1))) >= 3
             AND (
               public.f_unaccent(lower(tt.label)) LIKE public.f_unaccent(lower($1)) || '%'
               OR public.f_unaccent(lower($1)) LIKE public.f_unaccent(lower(tt.label)) || '%'
               OR word_similarity(public.f_unaccent(lower($1)), public.f_unaccent(lower(tt.label))) > 0.7
             )
        ), descendants AS (
          SELECT slug FROM matched
          UNION ALL
          SELECT n.slug FROM taxonomy_nodes n JOIN descendants d ON n.parent_slug = d.slug
        )
        SELECT slug FROM descendants
      ) THEN 0 ELSE 1 END, `
    : "";
  if (sort === "price_asc") return `${slugBoost}p.price_cents ASC NULLS LAST, p.updated_at DESC`;
  if (sort === "price_desc") return `${slugBoost}p.price_cents DESC NULLS LAST, p.updated_at DESC`;
  if (sort === "discount") return `${slugBoost}${DISCOUNT_SQL} DESC, ${ORDERS_SQL} DESC, p.updated_at DESC`;
  if (sort === "popular" || mode === "trending") return `${slugBoost}${ORDERS_SQL} DESC, ${RATING_SQL} DESC, p.updated_at DESC`;
  if (mode === "deals") return `${slugBoost}${DISCOUNT_SQL} DESC, p.price_cents ASC NULLS LAST, ${ORDERS_SQL} DESC`;
  if (mode === "feed") return `${slugBoost}${VIDEO_SQL} DESC, ${ORDERS_SQL} DESC, p.updated_at DESC`;
  if (mode === "bestvalue") return `${slugBoost}CASE WHEN COALESCE(p.price_cents, 0) > 0 THEN (${ORDERS_SQL}::numeric / p.price_cents) ELSE 0 END DESC, ${RATING_SQL} DESC, p.updated_at DESC`;
  if (mode === "toprated") return `${slugBoost}${RATING_SQL} DESC, ${ORDERS_SQL} DESC, p.updated_at DESC`;
  if (sort === "newest") return `${slugBoost}p.created_at DESC`;
  return `${slugBoost}p.created_at DESC`;
}

export async function searchProducts(filters: ProductFilters = {}) {
  const { limit = 50, offset = 0, locale = "ro", sort, mode, search } = filters;
  const includeCount = filters.includeCount === true;
  const { where, params, paramIndex } = buildSearchFilters(filters);
  const orderBy = buildOrderBy(sort, mode, search);
  const cappedLimit = Math.min(limit, 200);

  // Skip COUNT(*) by default — use LIMIT+1 for hasMore. Caller may opt in
  // with includeCount=true (rare admin/totals usage) at the cost of a full scan.
  const skipCount = !includeCount || mode === "video";
  const fetchLimit = skipCount ? cappedLimit + 1 : cappedLimit;

  const sql = `
    ${BASE_PRODUCT_COLUMNS}
    ${BASE_PRODUCT_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  const queryParams = [...params, fetchLimit, offset];
  const { rows } = await dbQuery<ProductRow>(sql, queryParams);

  let sliced = rows;
  let hasMore = false;
  let total = 0;

  if (skipCount) {
    hasMore = rows.length > cappedLimit;
    sliced = hasMore ? rows.slice(0, cappedLimit) : rows;
    total = offset + sliced.length + (hasMore ? 1 : 0); // approximation; caller should use hasMore
  } else {
    const countSql = `
      SELECT COUNT(*)::int AS total
      ${BASE_PRODUCT_SELECT}
      WHERE ${where.join(" AND ")}
    `;
    const { rows: countRows } = await dbQuery<{ total: number }>(countSql, params);
    total = Number(countRows[0]?.total || 0);
  }

  const slugList = sliced
    .map((r) => (typeof r.taxonomy_node_slug === "string" ? r.taxonomy_node_slug : ""))
    .filter((s: string) => s);
  const taxonomyMap = slugList.length > 0 ? await resolveTaxonomyLabels(slugList, locale) : undefined;
  const idList = sliced.map((r) => String(r.id)).filter(Boolean);
  const translationsMap = idList.length > 0 ? await loadProductTranslations(idList, locale) : undefined;
  const products = await applyReviewRatings(
    sliced.map((row) => transformProduct(row, locale, taxonomyMap, translationsMap)),
  );
  return { products, total, offset, limit: cappedLimit, hasMore };
}

export async function getProductById(id: string, locale = "ro") {
  const { rows } = await dbQuery<ProductRow>(
    `
      ${BASE_PRODUCT_COLUMNS}
      ${BASE_PRODUCT_SELECT}
      WHERE p.id::text = $1 OR p.supplier_product_id = $1 OR p.external_product_id = $1
      ORDER BY
        CASE
          WHEN p.id::text = $1 THEN 0
          WHEN p.supplier_product_id = $1 THEN 1
          ELSE 2
        END
      LIMIT 1
    `,
    [id],
  );
  if (rows.length === 0) return null;
  const slug = typeof rows[0].taxonomy_node_slug === "string" ? rows[0].taxonomy_node_slug : "";
  const taxonomyMap = slug ? await resolveTaxonomyLabels([slug], locale) : undefined;
  const translationsMap = await loadProductTranslations([String(rows[0].id)], locale);
  const [product] = await applyReviewRatings([transformProduct(rows[0], locale, taxonomyMap, translationsMap)]);
  return product;
}

// Doar produse clasice pot fi cumparate prin checkout-ul de cos. Verticalele
// (listing = zbor/cazare) au fluxuri proprii de rezervare cu preturi dinamice;
// un listing prin checkout ar crea o comanda clasica cu pretul static din DB,
// ocolind rezervarea reala.
const CHECKOUT_PRODUCT_GUARD = `p.status = 'active'
  AND COALESCE(p.is_adult, false) = false
  AND p.effective_label = 'safe'
  AND COALESCE(p.listing_type, 'product') = 'product'`;

export async function getCheckoutProductById(id: string) {
  type CheckoutRow = ProductRow & { seller_id: string | null; inventory_quantity: number | null };

  // 2026-08-24 (audit perf): `p.id::text = $1` anula cheia primara, deci fiecare
  // articol din cos declansa o scanare secventiala pe tot catalogul — pe calea
  // de plata, unde latenta e cea mai scumpa. Ordinea de prioritate
  // (id > supplier_product_id > external_product_id) se pastreaza dispatch-uind
  // in TypeScript: cand id-ul e un UUID incercam intai lookup-ul pe cheia
  // primara (castul e sigur, ruleaza doar sub UUID_RE).
  let rows: CheckoutRow[] = [];

  if (UUID_RE.test(id)) {
    const byId = await dbQuery<CheckoutRow>(
      `SELECT p.* FROM marketplace_products p
        WHERE ${CHECKOUT_PRODUCT_GUARD} AND p.id = $1::uuid
        LIMIT 1`,
      [id],
    );
    rows = byId.rows;
  }

  if (rows.length === 0) {
    const bySupplier = await dbQuery<CheckoutRow>(
      `SELECT p.* FROM marketplace_products p
        WHERE ${CHECKOUT_PRODUCT_GUARD}
          AND (p.supplier_product_id = $1 OR p.external_product_id = $1)
        ORDER BY CASE WHEN p.supplier_product_id = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      [id],
    );
    rows = bySupplier.rows;
  }

  if (rows.length === 0) return null;

  const row = rows[0];
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const priceCents = Number(row.price_cents);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    logger.warn(`[Checkout] Product ${id} has invalid price_cents: ${row.price_cents}`);
    return null;
  }

  const images = buildImages(row, metadata);
  const category = cleanCategoryLabel(
    firstNonEmpty(
      metadata.product_type_ro,
      metadata.product_type,
      metadata.ae_category_name_ro,
      metadata.ae_category_name,
      row.category,
    ),
    "General",
  );

  return {
    productId: String(row.id),
    aeProductId: String(firstNonEmpty(row.supplier_product_id, row.external_product_id, row.id)),
    sellerId: row.seller_id ? String(row.seller_id) : undefined,
    title: row.title,
    price: priceCents / 100,
    // ANPC: fara pret de referinta fabricat — doar compare_at real din DB.
    oldPrice: Number(row.compare_at_price_cents) > 0 ? Number(row.compare_at_price_cents) / 100 : undefined,
    image: images[0] || row.image_url || undefined,
    category,
    metadata,
    stock: row.inventory_quantity !== null && row.inventory_quantity !== undefined ? Number(row.inventory_quantity) : undefined,
  };
}

export async function getCategories(locale = "ro") {
  const { rows } = await dbQuery<CategoryRow>(
    `
      SELECT
        COALESCE(
          NULLIF(p.metadata->>'product_type', ''),
          NULLIF(p.category, ''),
          NULLIF(p.metadata->>'ae_category_name', ''),
          NULLIF(p.metadata->>'ae_root_category_name', ''),
          'General'
        ) AS name_en,
        COALESCE(
          NULLIF(p.metadata->>'product_type_ro', ''),
          NULLIF(p.category, ''),
          NULLIF(p.metadata->>'ae_category_name_ro', ''),
          NULLIF(p.metadata->>'ae_root_category_name_ro', ''),
          COALESCE(
            NULLIF(p.metadata->>'product_type', ''),
            NULLIF(p.category, ''),
            NULLIF(p.metadata->>'ae_category_name', ''),
            NULLIF(p.metadata->>'ae_root_category_name', ''),
            'General'
          )
        ) AS name_ro,
        COALESCE(
          NULLIF(p.taxonomy_node_slug, ''),
          NULLIF(p.canonical_category_slug, ''),
          NULLIF(p.taxonomy_slug, ''),
          md5(COALESCE(p.category, 'general'))
        ) AS category_id,
        COUNT(*)::int AS count
      ${BASE_PRODUCT_SELECT}
      WHERE p.status = 'active' AND COALESCE(p.is_adult, false) = false AND p.effective_label = 'safe'
      GROUP BY 1, 2, 3
      ORDER BY COUNT(*) DESC, 1 ASC
    `,
  );

  return rows.map((row) => mapCategoryRow(row, locale));
}

type CategoryRow = {
  name_en: string;
  name_ro: string;
  category_id: string;
  count: number;
};

function mapCategoryRow(row: CategoryRow, locale = "ro") {
  const nameEn = cleanCategoryLabel(row.name_en);

  return {
    id: String(row.category_id),
    name: cleanCategoryLabel(locale === "ro" ? row.name_ro : row.name_en, nameEn),
    nameEn,
    count: Number(row.count) || 0,
  };
}

function taxonomySlugPart(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "other";
}

function localizeTaxonomyLabel(value: unknown, locale = "ro") {
  const label = cleanCategoryLabel(value, "General");
  if (locale !== "ro") return label;
  const ro: Record<string, string> = {
    Fashion: "Fashion",
    Women: "Femei",
    Men: "Bărbați",
    Shoes: "Încălțăminte",
    Accessories: "Accesorii",
    Clothing: "Îmbrăcăminte",
    Bags: "Genți",
    Dresses: "Rochii",
    Pants: "Pantaloni",
    "T-Shirts": "Tricouri",
    "Shoes Accessories": "Accesorii încălțăminte",
    Toys: "Jucării",
    Kids: "Copii",
    Other: "Altele",
    General: "General",
  };
  return ro[label] || label;
}

export async function getCategoryHierarchy(locale = "ro") {
  // i18n-ready: read from taxonomy_nodes + taxonomy_translations.
  // Walks ancestors via recursive CTE so counts roll up; labels resolved per
  // locale with English fallback. Falls back to legacy string columns if the
  // new tables are not yet populated.
  const { rows } = await dbQuery<TaxonomyNodeRow>(
    `
      WITH RECURSIVE product_counts AS (
        SELECT taxonomy_node_slug AS slug, COUNT(*)::int AS direct_count
        FROM marketplace_products
        WHERE status = 'active'
          AND COALESCE(is_adult, false) = false AND effective_label = 'safe'
          AND COALESCE(listing_type, 'product') = 'product'
          AND taxonomy_node_slug IS NOT NULL
        GROUP BY taxonomy_node_slug
      ),
      ancestors AS (
        SELECT pc.slug AS leaf_slug, n.slug AS ancestor_slug, n.parent_slug, n.kind, n.sort_order, pc.direct_count, 0 AS depth
        FROM product_counts pc
        JOIN taxonomy_nodes n ON n.slug = pc.slug AND n.is_active = true
        UNION ALL
        SELECT a.leaf_slug, n.slug, n.parent_slug, n.kind, n.sort_order, a.direct_count, a.depth + 1
        FROM ancestors a
        JOIN taxonomy_nodes n ON n.slug = a.parent_slug AND n.is_active = true
        WHERE a.depth < 8
      ),
      node_counts AS (
        SELECT ancestor_slug AS slug, SUM(direct_count)::int AS total
        FROM ancestors
        GROUP BY ancestor_slug
      )
      SELECT
        n.slug,
        n.parent_slug,
        n.kind,
        n.sort_order,
        COALESCE(t_loc.label, t_en.label, n.slug) AS label,
        nc.total
      FROM node_counts nc
      JOIN taxonomy_nodes n ON n.slug = nc.slug
      LEFT JOIN taxonomy_translations t_loc ON t_loc.node_slug = n.slug AND t_loc.locale = $1
      LEFT JOIN taxonomy_translations t_en ON t_en.node_slug = n.slug AND t_en.locale = 'en'
        -- Verticalele cu pagină dedicată (Fly, Go) nu apar ca have categorii marketplace:
        -- produsele lor („Zbor spre X") trăiesc în feed, dar navigarea se face din /fly, /go.
        WHERE COALESCE(n.metadata->>'vertical', '') NOT IN ('fly', 'go')
      ORDER BY n.sort_order NULLS LAST, n.slug
    `,
    [locale],
  );

  if (rows.length === 0) {
    // Legacy fallback for pre-migration environments / tests.
    const legacy = await dbQuery<LegacyHierarchyRow>(
      `
        SELECT
          COALESCE(NULLIF(p.taxonomy_department, ''), 'Other') AS department,
          COALESCE(NULLIF(p.taxonomy_category, ''), 'General') AS category,
          COALESCE(NULLIF(p.taxonomy_subcategory, ''), 'General') AS subcategory,
          COALESCE(NULLIF(p.taxonomy_leaf, ''), NULLIF(p.canonical_category, ''), NULLIF(p.category, ''), 'General') AS leaf,
          COALESCE(NULLIF(p.taxonomy_slug, ''), NULLIF(p.canonical_category_slug, ''), md5(COALESCE(p.category, 'general'))) AS slug,
          COUNT(*)::int AS count
        FROM marketplace_products p
        WHERE p.status = 'active' AND COALESCE(p.is_adult, false) = false AND p.effective_label = 'safe'
          -- Listările de verticală (zboruri, curse) au pagini proprii (/fly, /go):
          -- nu intră în categoriile magazinului (audit shop 2026-09-25).
          AND COALESCE(p.listing_type, 'product') = 'product'
          AND COALESCE(p.metadata->>'vertical', '') NOT IN ('fly', 'go')
        GROUP BY 1,2,3,4,5
        HAVING COUNT(*) > 0
      `,
    );
    return buildCategoryHierarchy(legacy.rows, locale);
  }

  return buildTaxonomyNodeTree(rows);
}

type TaxonomyNodeRow = {
  slug: string;
  parent_slug: string | null;
  kind: string;
  sort_order: number | null;
  label: string;
  total: number;
};

type TaxonomyTreeNode = {
  id: string;
  name: string;
  tag: string;
  count: number;
  kind: string;
  _parent?: string | null;
  _sort?: number;
  children: TaxonomyTreeNode[];
};

function buildTaxonomyNodeTree(rows: TaxonomyNodeRow[]) {
  const nodes = new Map<string, TaxonomyTreeNode>();
  for (const r of rows) {
    nodes.set(r.slug, {
      id: r.slug,
      name: String(r.label),
      tag: r.slug,
      count: Number(r.total) || 0,
      kind: r.kind,
      _parent: r.parent_slug,
      _sort: r.sort_order ?? 9999,
      children: [],
    });
  }
  const roots: TaxonomyTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node._parent && nodes.has(node._parent)) {
      nodes.get(node._parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Hide the "Altele" bucket. Every non-empty node is shown: the catalog is small
  // (post-AliExpress), a <5 threshold hid every real category (audit shop 2026-09-25).
  const filtered = roots.filter((r) => r.id !== 'other' && r.count > 0);
  const sortRec = (list: TaxonomyTreeNode[]) => {
    list.sort((a, b) => ((a._sort ?? 9999) - (b._sort ?? 9999)) || (b.count - a.count) || a.name.localeCompare(b.name));
    for (const n of list) {
      if (n.children.length) sortRec(n.children);
      delete n._parent;
      delete n._sort;
    }
  };
  sortRec(filtered);
  return filtered;
}

type LegacyHierarchyRow = {
  department: string | null;
  category: string | null;
  subcategory: string | null;
  leaf: string | null;
  slug: string;
  count: number;
};

type HierarchyNode = {
  id: string;
  name: string;
  tag?: string;
  count: number;
  children?: HierarchyNode[];
};

function buildCategoryHierarchy(rows: LegacyHierarchyRow[], locale = "ro") {
  const roots: Record<string, HierarchyNode> = {};

  for (const row of rows) {
    const department = cleanCategoryLabel(row.department, "Other");
    const category = cleanCategoryLabel(row.category, "General");
    const subcategory = cleanCategoryLabel(row.subcategory, category);
    const leaf = cleanCategoryLabel(row.leaf, subcategory);
    const rootId = `department:${taxonomySlugPart(department)}`;
    if (!roots[rootId]) {
      roots[rootId] = {
        id: rootId,
        name: localizeTaxonomyLabel(department, locale),
        count: 0,
        children: [],
      };
    }

    const count = Number(row.count) || 0;
    const categoryId = `${rootId}:${taxonomySlugPart(category)}`;
    let categoryNode = roots[rootId].children!.find((child) => child.id === categoryId);
    if (!categoryNode) {
      categoryNode = { id: categoryId, name: localizeTaxonomyLabel(category, locale), count: 0, children: [] };
      roots[rootId].children!.push(categoryNode);
    }

    const subcategoryId = `${categoryId}:${taxonomySlugPart(subcategory)}`;
    let subcategoryNode = categoryNode.children!.find((child) => child.id === subcategoryId);
    if (!subcategoryNode) {
      subcategoryNode = { id: subcategoryId, name: localizeTaxonomyLabel(subcategory, locale), count: 0, children: [] };
      categoryNode.children!.push(subcategoryNode);
    }

    subcategoryNode.children!.push({
      id: String(row.slug),
      name: localizeTaxonomyLabel(leaf, locale),
      tag: String(row.slug),
      count,
    });
    subcategoryNode.count += count;
    categoryNode.count += count;
    roots[rootId].count += count;
  }

  const byCountThenName = (left: HierarchyNode, right: HierarchyNode) =>
    right.count - left.count || left.name.localeCompare(right.name);
  return Object.values(roots)
    .map((root) => ({
      ...root,
      children: root.children!
        .map((category) => ({
          ...category,
          children: category.children!
            .map((subcategory) => ({
              ...subcategory,
              children: subcategory.children!.sort(byCountThenName),
            }))
            .sort(byCountThenName),
        }))
        .sort(byCountThenName),
    }))
    .sort(byCountThenName);
}

export {
  buildSearchFilters as buildSearchFiltersForTest,
  buildCategoryHierarchy as buildCategoryHierarchyForTest,
  mapCategoryRow as mapCategoryRowForTest,
};
