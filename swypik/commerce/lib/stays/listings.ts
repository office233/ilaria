/**
 * Listările gazdei (CRUD) — rânduri în marketplace_products cu
 * metadata.vertical='stays' și metadata.host_user_id (model unic, 0051).
 * Pozele sunt acceptate doar din spațiul de upload al gazdei (/api/host/upload),
 * ca moderarea upload-ului să nu poată fi ocolită cu un URL arbitrar.
 */
import { z } from "zod";
import { objectKeyFromMediaUrl } from "@/lib/storage/config";
import { dbQuery } from "@/lib/db";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";
import { logger } from "@/lib/logger";
import { STAY_AMENITIES, STAY_PROPERTY_TYPES, staysConfig } from "./config";
import { StaysError } from "./errors";
import type { HostProfile } from "./hosts";
import { BLOCKING_BOOKING_SQL, STAY_LISTING_SQL } from "./sql";

const TYPE_TAXONOMY: Record<string, string> = {
    apartament: "vacation-rentals/apartments",
    casa: "vacation-rentals/houses",
    vila: "vacation-rentals/houses",
    cabana: "vacation-rentals/cabins",
    pensiune: "vacation-rentals/hotels",
    hotel: "vacation-rentals/hotels",
};

export function listingSchema() {
    return z.object({
        title: z.string().trim().min(5).max(140),
        description: z.string().trim().max(4000).optional(),
        pricePerNightCents: z.number().int().min(staysConfig.minPricePerNightCents()).max(staysConfig.maxPricePerNightCents()),
        imageUrls: z.array(z.string().url().max(600)).max(staysConfig.maxPhotos()).default([]),
        maxGuests: z.number().int().min(1).max(staysConfig.maxGuests()),
        city: z.string().trim().min(2).max(80),
        address: z.string().trim().max(200).optional(),
        propertyType: z.enum(STAY_PROPERTY_TYPES).optional(),
        amenities: z.array(z.enum(STAY_AMENITIES)).max(STAY_AMENITIES.length).default([]),
        houseRules: z.string().trim().max(2000).optional(),
    });
}
export type ListingInput = z.infer<ReturnType<typeof listingSchema>>;

/**
 * URL de poză încărcat de ACEASTĂ gazdă prin /api/host/upload: obiect din
 * bucket-ul NOSTRU (baza MEDIA_PUBLIC_BASE_URL) cu cheia `stays/<userId>/…`.
 * Doar calea nu ajungea: `https://evil/stays/<uid>/x.jpg` ocolea moderarea uploadului.
 */
export function isHostPhotoUrl(url: string, userId: string): boolean {
    const key = objectKeyFromMediaUrl(url);
    return key !== null && key.startsWith(`stays/${userId}/`);
}

function assertPhotos(urls: string[], userId: string): void {
    if (urls.some((u) => !isHostPhotoUrl(u, userId))) throw new StaysError("photo_not_allowed");
}

function attrs(input: ListingInput): Record<string, boolean | number> {
    const out: Record<string, boolean | number> = { max_guests: input.maxGuests, price_per_night: input.pricePerNightCents / 100 };
    for (const a of STAY_AMENITIES) out[a] = input.amenities.includes(a);
    return out;
}

function meta(input: ListingInput, userId: string, host: HostProfile): Record<string, unknown> {
    return {
        vertical: "stays",
        host_user_id: userId,
        property_type: input.propertyType ?? host.propertyType,
        county: host.county,
        max_guests: input.maxGuests,
        image_urls: input.imageUrls,
        address: input.address ?? null,
        house_rules: input.houseRules ?? null,
        price_unit: "night",
    };
}

export type HostListing = {
    id: string;
    title: string;
    description: string | null;
    image_url: string | null;
    price_cents: number | null;
    status: string;
    location_city: string | null;
    metadata: Record<string, unknown>;
    vertical_attributes: Record<string, unknown> | null;
    upcoming_bookings: number;
};

export async function listHostListings(userId: string): Promise<HostListing[]> {
    const { rows } = await dbQuery<HostListing>(
        `SELECT p.id::text, p.title, p.description, p.image_url, p.price_cents, p.status, p.location_city,
                p.metadata, p.vertical_attributes,
                (SELECT COUNT(*)::int FROM stay_bookings b
                  WHERE b.product_id = p.id AND ${BLOCKING_BOOKING_SQL} AND b.check_out >= CURRENT_DATE) AS upcoming_bookings
           FROM marketplace_products p
          WHERE ${STAY_LISTING_SQL} AND p.metadata->>'host_user_id' = $1 AND p.status <> 'archived'
          ORDER BY p.created_at DESC`,
        [userId],
    );
    return rows;
}

export async function createListing(userId: string, host: HostProfile, input: ListingInput): Promise<string> {
    assertPhotos(input.imageUrls, userId);
    const slugBase = input.title.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const type = input.propertyType ?? host.propertyType ?? "";
    const { rows } = await dbQuery<{ id: string }>(
        `INSERT INTO marketplace_products
            (title, description, slug, image_url, price_cents, currency, status, listing_type,
             taxonomy_node_slug, location_country, location_city, metadata, vertical_attributes)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', 'listing', $7, 'RO', $8, $9::jsonb, $10::jsonb)
         RETURNING id::text`,
        [
            input.title, input.description ?? null, `${slugBase}-${Date.now().toString(36)}`,
            input.imageUrls[0] ?? null, input.pricePerNightCents, DEFAULT_CURRENCY,
            TYPE_TAXONOMY[type] ?? "vacation-rentals", input.city,
            JSON.stringify(meta(input, userId, host)), JSON.stringify(attrs(input)),
        ],
    );
    logger.info({ listingId: rows[0].id, host: userId }, "stays: listing created (draft)");
    return rows[0].id;
}

async function ownedStatus(id: string, userId: string): Promise<string> {
    const { rows } = await dbQuery<{ status: string }>(
        `SELECT p.status FROM marketplace_products p
          WHERE p.id = $1::uuid AND ${STAY_LISTING_SQL} AND p.metadata->>'host_user_id' = $2 AND p.status <> 'archived'`,
        [id, userId],
    );
    if (!rows[0]) throw new StaysError("not_found");
    return rows[0].status;
}

export async function updateListing(id: string, userId: string, host: HostProfile, input: ListingInput): Promise<void> {
    const status = await ownedStatus(id, userId);
    assertPhotos(input.imageUrls, userId);
    // O listare publicată fără nicio poză ar ocoli verificarea de la publicare.
    if (status === "active" && input.imageUrls.length === 0) throw new StaysError("publish_incomplete");
    await dbQuery(
        `UPDATE marketplace_products
            SET title = $3, description = $4, image_url = $5, price_cents = $6, location_city = $7,
                metadata = metadata || $8::jsonb, vertical_attributes = COALESCE(vertical_attributes, '{}'::jsonb) || $9::jsonb,
                updated_at = now()
          WHERE id = $1::uuid AND metadata->>'host_user_id' = $2`,
        [
            id, userId, input.title, input.description ?? null, input.imageUrls[0] ?? null,
            input.pricePerNightCents, input.city, JSON.stringify(meta(input, userId, host)), JSON.stringify(attrs(input)),
        ],
    );
}

/** Publicarea cere poză, preț, oraș — altfel listarea ar apărea goală în /stays. */
export async function setPublished(id: string, userId: string, publish: boolean): Promise<string> {
    await ownedStatus(id, userId);
    const { rows } = await dbQuery<{ status: string }>(
        `UPDATE marketplace_products SET status = $3, updated_at = now()
          WHERE id = $1::uuid AND metadata->>'host_user_id' = $2
            AND ($3 = 'draft' OR (image_url IS NOT NULL AND COALESCE(price_cents, 0) > 0
                                   AND COALESCE(location_city, '') <> ''))
          RETURNING status`,
        [id, userId, publish ? "active" : "draft"],
    );
    if (!rows[0]) throw new StaysError("publish_incomplete");
    return rows[0].status;
}

/** „Ștergere” = arhivare (istoricul rezervărilor rămâne); refuzată cu rezervări viitoare. */
export async function archiveListing(id: string, userId: string): Promise<void> {
    await ownedStatus(id, userId);
    const { rows } = await dbQuery<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM stay_bookings b
          WHERE b.product_id = $1::uuid AND ${BLOCKING_BOOKING_SQL} AND b.check_out >= CURRENT_DATE`,
        [id],
    );
    if (Number(rows[0]?.n ?? 0) > 0) throw new StaysError("has_active_bookings");
    await dbQuery(
        `UPDATE marketplace_products SET status = 'archived', updated_at = now()
          WHERE id = $1::uuid AND metadata->>'host_user_id' = $2`,
        [id, userId],
    );
}

/** Proprietar al listării (pentru calendar); aruncă not_found altfel. */
export async function assertOwnsListing(id: string, userId: string): Promise<void> {
    await ownedStatus(id, userId);
}
