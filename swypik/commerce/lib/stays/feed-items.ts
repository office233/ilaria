/**
 * Listările Stays ca și carduri normalizate pentru feed-ul Home (toate
 * modulele apar ca și carduri în feed). Contract stabil, fără dependențe UI:
 *   { kind: "stay", id, title, image, href, priceLabel, ... }
 * Doar listări publicate, cu gazdă și cu poză (un card fără imagine nu are
 * ce căuta în feed-ul video).
 */
import { DEFAULT_LOCALE } from "@/lib/i18n/config";
import { searchStays, type StayResult } from "./search";

export type StayFeedItem = {
    kind: "stay";
    id: string;
    title: string;
    image: string;
    href: string;
    /** Preț/noapte formatat în limba cerută (ex. „250 RON”). Unitatea „/noapte” o adaugă UI-ul. */
    priceLabel: string;
    priceCents: number;
    currency: string;
    priceUnit: "night";
    subtitle: string | null;
    rating: number | null;
    reviewsCount: number;
    maxGuests: number | null;
};

export function formatPrice(cents: number, currency: string, locale: string): string {
    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
        maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(
        cents / 100,
    );
}

export function toFeedItem(r: StayResult, locale: string): StayFeedItem | null {
    if (!r.image || r.pricePerNightCents <= 0) return null;
    return {
        kind: "stay",
        id: r.id,
        title: r.title,
        image: r.image,
        href: `/stays/${r.id}`,
        priceLabel: formatPrice(r.pricePerNightCents, r.currency, locale),
        priceCents: r.pricePerNightCents,
        currency: r.currency,
        priceUnit: "night",
        subtitle: r.city,
        rating: r.rating,
        reviewsCount: r.reviewsCount,
        maxGuests: r.maxGuests,
    };
}

export async function getStaysFeedItems(opts: { limit?: number; locale?: string; city?: string | null } = {}): Promise<StayFeedItem[]> {
    const locale = opts.locale ?? DEFAULT_LOCALE;
    const results = await searchStays({ q: opts.city ?? null, limit: opts.limit ?? 12 });
    return results.map((r) => toFeedItem(r, locale)).filter((x): x is StayFeedItem => x !== null);
}
