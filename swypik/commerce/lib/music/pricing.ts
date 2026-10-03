import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import {
    MUSIC_ALBUM_DISCOUNT_PCT,
    MUSIC_ARTIST_SHARE_BPS,
    MUSIC_TRACK_PRICE_MAX_CENTS,
    MUSIC_TRACK_PRICE_MIN_CENTS,
} from "./config";
import type { MusicAlbumRow, MusicTrackRow } from "./types";

/**
 * Prețul unui album în RON (cenți): cel setat explicit de artist, altfel suma
 * pieselor premium cu preț setat, cu reducerea de album. `null` dacă albumul
 * nu are niciun preț RON de calculat încă ("preț în curând").
 */
export function albumPriceCents(
    album: Pick<MusicAlbumRow, "price_cents">,
    tracks: Pick<MusicTrackRow, "is_premium" | "price_cents">[],
    discountPct: number = MUSIC_ALBUM_DISCOUNT_PCT,
): number | null {
    if (album.price_cents && album.price_cents > 0) return album.price_cents;
    const priced = tracks.filter((t) => t.is_premium && t.price_cents !== null && t.price_cents > 0);
    if (priced.length === 0) return null;
    const sum = priced.reduce((acc, t) => acc + Number(t.price_cents ?? 0), 0);
    return Math.round(sum * (1 - discountPct / 100));
}

export function clampTrackPriceCents(cents: number): number {
    const n = Math.trunc(Number(cents) || 0);
    return Math.min(MUSIC_TRACK_PRICE_MAX_CENTS, Math.max(MUSIC_TRACK_PRICE_MIN_CENTS, n));
}

/**
 * Cota artistului dintr-o deblocare, în cenți RON. Plătit prin Stripe,
 * creditat pe `lib/wallet/ledger.ts` (nu mai trece prin sistemul legacy de recompense).
 */
export function artistShareCents(amountCents: number, artistUserId: string, viewerUserId: string, shareBps: number = MUSIC_ARTIST_SHARE_BPS): number {
    if (amountCents <= 0) return 0;
    if (artistUserId === SWYPIK_OFFICIAL_ID || artistUserId === viewerUserId) return 0;
    return Math.floor((amountCents * shareBps) / 10_000);
}
