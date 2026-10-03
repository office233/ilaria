/**
 * Lista publică de comercianți (GET /api/merchants) — parsare query + SQL
 * parametrizat. Pur (fără DB), ca să fie testabil.
 *
 * Filtre: oraș (city_key, fără diacritice), tip, bucătărie (toate aliasurile
 * id-ului canonic), căutare text (nume/descriere), geo (raza de livrare),
 * mod de listare (orderable | suggest_only). Sortări: recommended (parteneri
 * comandabili cu meniu primii), distance, fee, time, name.
 */
import { z } from "zod";
import { cityKey } from "./city";
import { cuisineMatchValues } from "@/lib/merchants/cuisines";
import { FOOD_LIST_DEFAULT_LIMIT, FOOD_LIST_MAX_LIMIT } from "./config";
import { LISTING_MODE_SELECT_SQL, MERCHANT_LISTING_MODES } from "@/lib/merchants/listing-mode";

import { MERCHANT_KINDS, MERCHANT_SORTS, type MerchantSort } from "./merchant-list-options";

const QuerySchema = z.object({
  city: z.string().trim().max(120).optional().catch(undefined),
  kind: z.enum(MERCHANT_KINDS).optional().catch(undefined),
  cuisine: z.string().trim().max(40).optional().catch(undefined),
  q: z.string().trim().max(80).optional().catch(undefined),
  lat: z.coerce.number().min(-90).max(90).optional().catch(undefined),
  lng: z.coerce.number().min(-180).max(180).optional().catch(undefined),
  sort: z.enum(MERCHANT_SORTS).catch("recommended").default("recommended"),
  mode: z.enum(MERCHANT_LISTING_MODES).optional().catch(undefined),
  open: z.literal("1").optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(FOOD_LIST_MAX_LIMIT).catch(FOOD_LIST_DEFAULT_LIMIT).default(FOOD_LIST_DEFAULT_LIMIT),
  page: z.coerce.number().int().min(1).max(500).catch(1).default(1),
});
export type MerchantListQuery = z.infer<typeof QuerySchema>;

export function parseMerchantListQuery(url: URL): MerchantListQuery {
  const raw: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (v !== "") raw[k] = v;
  });
  // Parametrii invalizi (ex. kind necunoscut) sunt ignorați individual (.catch), nu 400.
  return QuerySchema.parse(raw);
}

const PUBLIC_COLS = `
  m.id, m.kind, m.name, m.slug, m.description, m.cuisine_types, m.phone, m.address,
  m.location_country, m.location_city, m.location_lat, m.location_lng,
  m.delivery_radius_km, m.min_order_cents, m.delivery_fee_cents, m.avg_prep_minutes,
  m.opening_hours, m.is_open_override, m.status, m.image_url, m.created_at, m.source,
  m.suggestion_count, (m.seller_id IS NOT NULL) AS is_claimed,
  NULL::numeric AS rating,
  ${LISTING_MODE_SELECT_SQL}`;

/** Escapare pentru ILIKE (%, _, \). */
function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function buildMerchantListSql(q: MerchantListQuery): { sql: string; params: unknown[] } {
  const where: string[] = ["m.status = 'active'"];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const hasGeo = q.lat !== undefined && q.lng !== undefined && !(q.lat === 0 && q.lng === 0);
  if (!hasGeo && q.city) where.push(`m.city_key = ${p(cityKey(q.city))}`);
  if (q.kind) where.push(`m.kind = ${p(q.kind)}`);
  if (q.cuisine) {
    const values = cuisineMatchValues(q.cuisine);
    where.push(`m.cuisine_types && ${p(values.length ? values : [q.cuisine.toLowerCase()])}::text[]`);
  }
  if (q.q) {
    const pat = p(likePattern(q.q));
    where.push(`(m.name ILIKE ${pat} OR m.description ILIKE ${pat})`);
  }
  if (q.mode) where.push(`m.listing_mode = ${p(q.mode)}`);

  let distanceSelect = "NULL::float AS distance_km";
  if (hasGeo) {
    const pLat = `${p(q.lat)}::float`;
    const pLng = `${p(q.lng)}::float`;
    const dist = `(6371 * acos(least(1, cos(radians(${pLat})) * cos(radians(m.location_lat)) * cos(radians(m.location_lng) - radians(${pLng})) + sin(radians(${pLat})) * sin(radians(m.location_lat)))))`;
    distanceSelect = `${dist} AS distance_km`;
    where.push(`m.location_lat IS NOT NULL AND m.location_lng IS NOT NULL AND ${dist} <= COALESCE(m.delivery_radius_km, 5.0)`);
  }

  const partnerFirst = "(m.listing_mode = 'orderable') DESC, (mc.menu_count > 0) DESC";
  const orderBy: Record<MerchantSort, string> = {
    recommended: `${partnerFirst}, ${hasGeo ? "distance_km ASC NULLS LAST, " : ""}m.suggestion_count DESC, m.created_at DESC`,
    distance: `${partnerFirst}, ${hasGeo ? "distance_km ASC NULLS LAST, " : ""}m.name ASC`,
    fee: `${partnerFirst}, m.delivery_fee_cents ASC NULLS LAST, m.name ASC`,
    time: `${partnerFirst}, m.avg_prep_minutes ASC NULLS LAST, m.name ASC`,
    name: `${partnerFirst}, m.name ASC`,
  };

  const limit = p(q.limit);
  const offset = p((q.page - 1) * q.limit);
  const sql = `SELECT ${PUBLIC_COLS}, ${distanceSelect}, mc.menu_count
      FROM local_merchants m
      CROSS JOIN LATERAL (
        SELECT count(1)::int AS menu_count FROM menu_items mi WHERE mi.merchant_id = m.id AND mi.is_available
      ) mc
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy[q.sort]}
     LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params };
}
