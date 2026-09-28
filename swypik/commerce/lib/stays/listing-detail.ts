/**
 * Datele publice ale unei cazări pentru pagina de detaliu (server).
 */
import { dbQuery } from "@/lib/db";
import { STAY_AMENITIES, type StayAmenity } from "./config";
import { perNightCents } from "./policy";
import { PUBLIC_STAY_SQL } from "./sql";

export type StayDetail = {
    id: string;
    title: string;
    description: string | null;
    images: string[];
    city: string | null;
    address: string | null;
    propertyType: string | null;
    maxGuests: number | null;
    pricePerNightCents: number;
    currency: string;
    amenities: StayAmenity[];
    houseRules: string | null;
    hostUserId: string;
    hostName: string | null;
    hostAvatar: string | null;
};

type Row = {
    id: string;
    title: string;
    description: string | null;
    image_url: string | null;
    location_city: string | null;
    price_cents: number | null;
    currency: string | null;
    metadata: Record<string, unknown>;
    vertical_attributes: Record<string, unknown> | null;
    host_name: string | null;
    host_avatar: string | null;
};

export async function getStayDetail(id: string): Promise<StayDetail | null> {
    const { rows } = await dbQuery<Row>(
        `SELECT p.id::text, p.title, p.description, p.image_url, p.location_city, p.price_cents, p.currency,
                p.metadata, p.vertical_attributes,
                COALESCE(u.display_name, u.first_name) AS host_name, u.avatar_url AS host_avatar
           FROM marketplace_products p
           LEFT JOIN users u ON u.id::text = p.metadata->>'host_user_id'
          WHERE p.id = $1::uuid AND ${PUBLIC_STAY_SQL}`,
        [id],
    );
    const r = rows[0];
    if (!r) return null;
    const m = r.metadata ?? {};
    const gallery = Array.isArray(m.image_urls) ? m.image_urls.filter((u): u is string => typeof u === "string") : [];
    const images = gallery.length ? gallery : r.image_url ? [r.image_url] : [];
    const attrs = r.vertical_attributes ?? {};
    return {
        id: r.id,
        title: r.title,
        description: r.description,
        images,
        city: r.location_city,
        address: typeof m.address === "string" ? m.address : null,
        propertyType: typeof m.property_type === "string" ? m.property_type : null,
        maxGuests: Number.isFinite(Number(m.max_guests)) ? Number(m.max_guests) : null,
        pricePerNightCents: perNightCents(r),
        currency: r.currency ?? "RON",
        amenities: STAY_AMENITIES.filter((a) => attrs[a] === true),
        houseRules: typeof m.house_rules === "string" ? m.house_rules : null,
        hostUserId: String(m.host_user_id),
        hostName: r.host_name,
        hostAvatar: r.host_avatar,
    };
}
