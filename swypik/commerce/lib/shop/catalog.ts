/**
 * Catalogul magazinului cu paginare pe CURSOR (keyset) — folosit de /shop,
 * /categories/[slug] și /api/shop/products. Filtrele (căutare full-text,
 * categorie cu descendenți, preț) vin din `buildSearchFilters`, aceeași logică
 * ca restul listărilor; aici se adaugă doar: produse cumpărabile (fără
 * listări/verticale), sortare stabilă și cursorul.
 */
import { dbQuery } from "@/lib/db";
import { buildSearchFilters, loadProductTranslations } from "@/lib/db/product-queries";
import { getProductRatingMap } from "@/lib/reviews/aggregate";
import { CATALOG_PAGE_SIZE } from "./config";
import type { CatalogSort } from "./schemas";

export type CatalogCard = {
  id: string;
  title: string;
  priceCents: number;
  compareAtCents: number | null;
  currency: string;
  image: string | null;
  hasVideo: boolean;
  rating: number | null;
  ratingCount: number;
};

export type CatalogPage = { items: CatalogCard[]; nextCursor: string | null };

export type CatalogParams = {
  q?: string;
  category?: string;
  sort: CatalogSort;
  minPrice?: number;
  maxPrice?: number;
  cursor?: string;
  limit?: number;
  locale: string;
};

type Cursor = { k: number; id: string };

/** Cheia de sortare numerică + direcția; id-ul departajează egalitățile. */
const SORT_KEYS: Record<CatalogSort, { expr: string; dir: "ASC" | "DESC" }> = {
  newest: { expr: "floor(extract(epoch from p.created_at) * 1000)::numeric", dir: "DESC" },
  price_asc: { expr: "p.price_cents::numeric", dir: "ASC" },
  price_desc: { expr: "p.price_cents::numeric", dir: "DESC" },
  popular: {
    expr: `(SELECT COALESCE(SUM(oi.quantity), 0) FROM commerce_order_items oi
              JOIN commerce_orders o ON o.id = oi.order_id
             WHERE oi.product_id = p.id AND o.status IN ('paid', 'fulfilled', 'delivered'))::numeric`,
    dir: "DESC",
  },
  rating: {
    expr: `COALESCE((SELECT AVG(r.rating) FROM product_reviews r WHERE r.product_id = p.id AND r.is_hidden = false), 0)::numeric`,
    dir: "DESC",
  },
};

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.k !== "number" || !Number.isFinite(parsed.k) || typeof parsed.id !== "string") return null;
    if (!/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return { k: parsed.k, id: parsed.id };
  } catch {
    return null;
  }
}

type Row = {
  id: string;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  currency: string;
  image_url: string | null;
  has_video: boolean;
  sort_key: string;
};

export async function listCatalog(params: CatalogParams): Promise<CatalogPage> {
  const limit = Math.min(Math.max(params.limit ?? CATALOG_PAGE_SIZE, 1), 48);
  // Nodurile de taxonomie au slug-uri simple; ierarhia de rezervă (produse fără
  // nod) folosește id-uri `department:…`, filtrate pe coloanele taxonomy_*.
  const legacyCategory = params.category?.startsWith("department:") ? params.category : undefined;
  const { where, params: sqlParams, paramIndex } = buildSearchFilters({
    search: params.q || undefined,
    taxonomyNodeSlug: legacyCategory ? undefined : params.category || undefined,
    categoryId: legacyCategory,
    minPrice: params.minPrice,
    maxPrice: params.maxPrice,
    locale: params.locale,
  });
  where.push("COALESCE(p.listing_type, 'product') = 'product'");
  where.push("COALESCE(p.metadata->>'vertical', '') NOT IN ('fly', 'go')");

  const sort = SORT_KEYS[params.sort];
  const cursor = decodeCursor(params.cursor);
  const values: unknown[] = [...sqlParams];
  let cursorClause = "";
  let next = paramIndex;
  if (cursor) {
    const op = sort.dir === "DESC" ? "<" : ">";
    cursorClause = `WHERE (s.sort_key, s.id) ${op} ($${next}::numeric, $${next + 1}::uuid)`;
    values.push(cursor.k, cursor.id);
    next += 2;
  }
  values.push(limit + 1);

  const { rows } = await dbQuery<Row>(
    `SELECT s.* FROM (
       SELECT p.id, p.title, p.price_cents, p.compare_at_price_cents, p.currency, p.image_url,
              EXISTS (
                SELECT 1 FROM videos v
                 WHERE v.product_refs @> jsonb_build_array(jsonb_build_object('product_id', p.id::text))
                   AND v.status = 'ready' AND v.visibility = 'public' AND COALESCE(v.is_hidden, false) = false
              ) OR EXISTS (
                SELECT 1 FROM video_product_links vpl JOIN videos v ON v.id = vpl.video_id
                 WHERE vpl.product_id = p.id AND v.status = 'ready' AND v.visibility = 'public'
                   AND COALESCE(v.is_hidden, false) = false
              ) AS has_video,
              ${sort.expr} AS sort_key
         FROM marketplace_products p
        WHERE ${where.join(" AND ")}
     ) s
     ${cursorClause}
     ORDER BY s.sort_key ${sort.dir}, s.id ${sort.dir}
     LIMIT $${next}`,
    values,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = page.map((r) => String(r.id));
  const [translations, ratings] = await Promise.all([
    ids.length ? loadProductTranslations(ids, params.locale) : Promise.resolve(new Map()),
    ids.length ? getProductRatingMap(ids) : Promise.resolve(new Map()),
  ]);

  const items = page.map((r): CatalogCard => {
    const id = String(r.id);
    const agg = ratings.get(id);
    const compare = Number(r.compare_at_price_cents) || 0;
    return {
      id,
      title: translations.get(id)?.title || r.title,
      priceCents: Number(r.price_cents),
      compareAtCents: compare > Number(r.price_cents) ? compare : null,
      currency: String(r.currency || "RON").trim().toUpperCase(),
      image: r.image_url,
      hasVideo: Boolean(r.has_video),
      rating: agg && agg.reviewCount > 0 ? Math.round(agg.avgRating * 10) / 10 : null,
      ratingCount: agg?.reviewCount ?? 0,
    };
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ k: Number(last.sort_key), id: String(last.id) }) : null,
  };
}
