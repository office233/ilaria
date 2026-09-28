/**
 * Căutarea în inventarul propriu Stays (gazde Swypik). Nu depinde de niciun
 * furnizor extern, deci nu mai poate da 503 „neconfigurat”.
 *  - text: oraș sau titlu, fără diacritice și fără potrivire exactă
 *    („cluj” găsește „Cluj-Napoca”, „bucuresti” găsește „București”)
 *  - date: exclude listările cu nopți ocupate/blocate în interval
 *  - oaspeți: max_guests ≥ cerut
 */
import { dbQuery } from "@/lib/db";
import { staysConfig } from "./config";
import { isIsoDate, nightsCount } from "./dates";
import { perNightCents } from "./policy";
import { BLOCKING_BOOKING_SQL, PUBLIC_STAY_SQL, sqlNormalize } from "./sql";

export function normalizeText(s: string): string {
    return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export type StaySearchInput = {
    q?: string | null;
    checkIn?: string | null;
    checkOut?: string | null;
    guests?: number | null;
    limit?: number;
    excludeHostUserId?: string | null;
};

export type StayResult = {
    id: string;
    title: string;
    image: string | null;
    city: string | null;
    pricePerNightCents: number;
    currency: string;
    maxGuests: number | null;
    rating: number | null;
    reviewsCount: number;
    propertyType: string | null;
};

type Row = {
    id: string;
    title: string;
    image_url: string | null;
    location_city: string | null;
    price_cents: number | null;
    vertical_attributes: Record<string, unknown> | null;
    currency: string | null;
    max_guests: number | null;
    property_type: string | null;
    rating: string | null;
    reviews_count: number;
};

export async function searchStays(input: StaySearchInput): Promise<StayResult[]> {
    const where: string[] = [PUBLIC_STAY_SQL];
    const params: unknown[] = [];
    const add = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
    };

    const q = input.q ? normalizeText(input.q).slice(0, 80) : "";
    if (q.length >= 2) {
        const p = add(q);
        where.push(`(position(${p} in ${sqlNormalize("COALESCE(p.location_city, '')")}) > 0
                  OR position(${p} in ${sqlNormalize("p.title")}) > 0)`);
    }
    if (input.guests && input.guests > 0) {
        where.push(`COALESCE((p.metadata->>'max_guests')::int, ${add(staysConfig.maxGuests())}) >= ${add(input.guests)}`);
    }
    if (isIsoDate(input.checkIn) && isIsoDate(input.checkOut) && nightsCount(input.checkIn, input.checkOut) > 0) {
        const ci = add(input.checkIn);
        const co = add(input.checkOut);
        where.push(`NOT EXISTS (SELECT 1 FROM stay_bookings b WHERE b.product_id = p.id AND ${BLOCKING_BOOKING_SQL}
                      AND daterange(b.check_in, b.check_out) && daterange(${ci}::date, ${co}::date))`);
        where.push(`NOT EXISTS (SELECT 1 FROM stay_availability a WHERE a.product_id = p.id AND a.is_available = false
                      AND a.day >= ${ci}::date AND a.day < ${co}::date)`);
    }
    if (input.excludeHostUserId) where.push(`p.metadata->>'host_user_id' <> ${add(input.excludeHostUserId)}`);

    const limit = Math.min(Math.max(1, input.limit ?? staysConfig.searchLimit()), 100);
    const { rows } = await dbQuery<Row>(
        `SELECT p.id::text, p.title, p.image_url, p.location_city, p.price_cents, p.vertical_attributes, p.currency,
                (p.metadata->>'max_guests')::int AS max_guests, p.metadata->>'property_type' AS property_type,
                r.rating::text AS rating, COALESCE(r.n, 0)::int AS reviews_count
           FROM marketplace_products p
           LEFT JOIN LATERAL (
                SELECT round(avg(rating)::numeric, 1) AS rating, COUNT(*) AS n
                  FROM stay_reviews sr WHERE sr.product_id = p.id AND sr.status = 'published'
           ) r ON true
          WHERE ${where.join(" AND ")}
          ORDER BY r.rating DESC NULLS LAST, p.created_at DESC
          LIMIT ${add(limit)}`,
        params,
    );
    return rows.map((r) => ({
        id: r.id,
        title: r.title,
        image: r.image_url,
        city: r.location_city,
        pricePerNightCents: perNightCents(r),
        currency: r.currency ?? "RON",
        maxGuests: r.max_guests,
        rating: r.rating === null ? null : Number(r.rating),
        reviewsCount: r.reviews_count,
        propertyType: r.property_type,
    }));
}
