/**
 * Universal Marketplace — Listings (anunțuri)
 *
 * POST /api/listings  → publică un anunț (imobiliare / auto / servicii).
 *   Spre deosebire de /api/seller/products, aici NU există stoc/checkout:
 *   anunțul generează lead-uri prin /api/inquiries.
 *
 * GET  /api/listings  → listă publică, filtrabilă pe verticală + atribute.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { ListingCreateSchema, parseBody } from "@/lib/validation/schemas";
import {
    listingTypeForSlug,
    validateVerticalAttributes,
    verticalForSlug,
} from "@/lib/verticals/registry";
import { isLocale, LOCALE_COOKIE, DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";
import { labelProduct } from "@/lib/moderation/labelProduct";
import { autoEmbedProduct } from "@/lib/ai/auto-embed";
import { logger } from "@/lib/logger";
import { slugify } from "@/lib/merchants/slug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const LISTING_COLS = `
  id, slug, title, description, price_cents, currency, listing_type,
  taxonomy_node_slug, vertical_attributes, location_country, location_city,
  image_url, status, created_at
`;

export async function POST(req: Request) {
    try {
        const sellerId = await getSellerSessionId();
        if (!sellerId) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        const rl = await rateLimit("sellerProducts", sellerId);
        if (!rl.success) {
            return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
        }

        const raw = await req.json().catch(() => null);
        const parsed = parseBody(ListingCreateSchema, raw);
        if (!parsed.ok) {
            return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
        }
        const d = parsed.data;

        // Cazările au un singur model de gazdă (20260926_0051): se publică din
        // /stays/manage după aprobarea aplicației, nu ca anunț universal —
        // altfel gazda n-ar fi plătită niciodată (lipsea host_user_id).
        if (d.taxonomy_node_slug === "vacation-rentals" || d.taxonomy_node_slug.startsWith("vacation-rentals/")) {
            return NextResponse.json({ success: false, error: "use_host_onboarding" }, { status: 409 });
        }

        // Verticala determină ce câmpuri sunt permise/obligatorii.
        const vertical = verticalForSlug(d.taxonomy_node_slug);
        if (!vertical) {
            return NextResponse.json(
                { success: false, error: "Categoria selectată nu acceptă anunțuri." },
                { status: 400 },
            );
        }

        const attrs = validateVerticalAttributes(d.taxonomy_node_slug, d.vertical_attributes);
        if (!attrs.ok) {
            return NextResponse.json(
                { success: false, error: "Câmpuri invalide pentru această categorie.", fields: attrs.errors },
                { status: 400 },
            );
        }

        // Prețul e obligatoriu, cu excepția verticalelor marcate priceOptional (servicii).
        if (d.price === undefined && !vertical.priceOptional) {
            return NextResponse.json({ success: false, error: "Prețul este obligatoriu." }, { status: 400 });
        }

        const priceCents = d.price !== undefined ? Math.round(d.price * 100) : null;
        const slug = `${slugify(d.title)}-${Date.now().toString(36)}`;
        const listingType = listingTypeForSlug(d.taxonomy_node_slug);

        const meta: Record<string, unknown> = { seller_id: sellerId };
        if (d.image_urls?.length) meta.image_urls = d.image_urls;

        const { rows } = await dbQuery(
            `INSERT INTO marketplace_products (
         source_type, seller_id, title, slug, description,
         price_cents, currency, category, taxonomy_node_slug,
         status, inventory_status, listing_type, vertical_attributes,
         location_country, location_city, location_lat, location_lng,
         contact_phone, contact_email, image_url, metadata
       ) VALUES (
         'seller', $1, $2, $3, $4,
         $5, $6, $7, $8,
         'active', 'unknown', $9, $10::jsonb,
         $11, $12, $13, $14,
         $15, $16, $17, $18::jsonb
       )
       RETURNING ${LISTING_COLS}`,
            [
                sellerId,
                d.title,
                slug,
                d.description ?? null,
                priceCents,
                d.currency,
                d.taxonomy_node_slug,
                d.taxonomy_node_slug,
                listingType,
                JSON.stringify(attrs.clean),
                d.location_country ?? null,
                d.location_city ?? null,
                d.location_lat ?? null,
                d.location_lng ?? null,
                d.contact_phone ?? null,
                d.contact_email ?? null,
                d.image_urls?.[0] ?? null,
                JSON.stringify(meta),
            ],
        );

        const listingId: string | undefined = rows[0]?.id;

        if (listingId) {
            autoEmbedProduct(listingId, d.title, d.description ?? null);
            labelProduct({
                id: listingId,
                title: d.title,
                description: d.description ?? null,
                category: d.taxonomy_node_slug,
            }).catch(() => { });

            const cookieStore = await cookies();
            const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
            const locale: Locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;
            await dbQuery(
                `INSERT INTO product_translations (product_id, locale, title, description, slug, source)
         VALUES ($1, $2, $3, $4, $5, 'seller')
         ON CONFLICT (product_id, locale) DO UPDATE
           SET title = EXCLUDED.title, description = EXCLUDED.description,
               slug = EXCLUDED.slug, source = 'seller'`,
                [listingId, locale, d.title, d.description ?? null, slug],
            ).catch((e) => logger.warn({ err: e?.message }, "[listings] translation insert failed"));
        }

        return NextResponse.json({ success: true, listing: rows[0] });
    } catch (error: unknown) {
        logger.error({ err: error }, "[listings] POST error");
        return NextResponse.json({ success: false, error: "Eroare la publicarea anunțului." }, { status: 500 });
    }
}

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const slug = url.searchParams.get("taxonomy")?.trim() || null;
        const country = url.searchParams.get("country")?.trim().toUpperCase() || null;
        const city = url.searchParams.get("city")?.trim() || null;
        // `searchParams.get` da null cand parametrul lipseste, iar Number(null) e 0
        // — nu NaN. Fara garda asta, Number.isFinite trecea si se adauga mereu
        // filtrul `price_cents <= 0`, deci ruta nu intorcea niciun anunt cu pret.
        const minPriceRaw = url.searchParams.get("min_price");
        const maxPriceRaw = url.searchParams.get("max_price");
        const minPrice = minPriceRaw ? Number(minPriceRaw) : NaN;
        const maxPrice = maxPriceRaw ? Number(maxPriceRaw) : NaN;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), 100);
        const page = Math.max(Number(url.searchParams.get("page")) || 1, 1);
        const offset = (page - 1) * limit;

        const where: string[] = ["status = 'active'", "listing_type = 'listing'"];
        const params: unknown[] = [];

        if (slug) {
            params.push(slug);
            where.push(`(taxonomy_node_slug = $${params.length} OR taxonomy_node_slug LIKE $${params.length} || '/%')`);
        }
        if (country) {
            params.push(country);
            where.push(`location_country = $${params.length}`);
        }
        if (city) {
            params.push(city);
            where.push(`location_city ILIKE $${params.length}`);
        }
        if (Number.isFinite(minPrice)) {
            params.push(Math.round(minPrice * 100));
            where.push(`price_cents >= $${params.length}`);
        }
        if (Number.isFinite(maxPrice)) {
            params.push(Math.round(maxPrice * 100));
            where.push(`price_cents <= $${params.length}`);
        }

        // Filtre pe atribute specifice verticalei: ?attr.fuel=diesel&attr.rooms_min=3
        const vertical = verticalForSlug(slug);
        if (vertical) {
            for (const f of vertical.fields) {
                if (!f.filterable) continue;
                const eq = url.searchParams.get(`attr.${f.key}`);
                if (eq) {
                    params.push(JSON.stringify({ [f.key]: f.type === "boolean" ? eq === "true" : eq }));
                    where.push(`vertical_attributes @> $${params.length}::jsonb`);
                }
                if (f.type === "number" || f.type === "year") {
                    const min = Number(url.searchParams.get(`attr.${f.key}_min`));
                    if (Number.isFinite(min)) {
                        params.push(f.key, min);
                        where.push(`(vertical_attributes ->> $${params.length - 1})::numeric >= $${params.length}`);
                    }
                    const max = Number(url.searchParams.get(`attr.${f.key}_max`));
                    if (Number.isFinite(max)) {
                        params.push(f.key, max);
                        where.push(`(vertical_attributes ->> $${params.length - 1})::numeric <= $${params.length}`);
                    }
                }
            }
        }

        params.push(limit, offset);
        const { rows } = await dbQuery(
            `SELECT ${LISTING_COLS}
         FROM marketplace_products
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
        );

        return NextResponse.json({ success: true, listings: rows, page, limit });
    } catch (error: unknown) {
        logger.error({ err: error }, "[listings] GET error");
        return NextResponse.json({ success: false, error: "Eroare la încărcarea anunțurilor." }, { status: 500 });
    }
}
