/**
 * Cardul normalizat prin care Movies și Music apar în feed-ul Home.
 * Producători: lib/movies/feed-items.ts, lib/music/feed-items.ts.
 * Consumator: agregatorul feed-ului (îl alege pe `kind`).
 */
export type ModuleFeedCardKind = "movie_title" | "music_track";

export type ModuleFeedCard = {
    kind: ModuleFeedCardKind;
    /** Id-ul entității din modul (movie_series.id / music_tracks.id). */
    id: string;
    title: string;
    /** Rândul secundar: creator/artist (nume propriu, nu se traduce). */
    subtitle: string | null;
    image: string | null;
    /** Ruta internă (fără prefix de limbă). */
    href: string;
    /** Clip redabil direct în feed (episodul 1 gratuit / preview audio); null = doar card static. */
    media: { type: "video"; videoId: string } | { type: "audio"; url: string; durationMs: number } | null;
    /** Accesul de bază e gratuit (episoade gratuite / piesă gratuită). */
    isFree: boolean;
    genres: string[];
    /** Atribuirea cerută de licență (CC BY), de afișat pe card; null dacă nu e cazul. */
    attribution: string | null;
    /** Licența permite folosirea în contextul monetizat al feed-ului. */
    licensedForCommercial: boolean;
    publishedAt: string | null;
};

export type FeedItemsOptions = { limit?: number; includeAdult?: boolean };

export const FEED_ITEMS_DEFAULT_LIMIT = 10;
export const FEED_ITEMS_MAX_LIMIT = 50;

export function clampFeedLimit(limit: number | undefined): number {
    const n = Number.isFinite(limit) ? Math.trunc(limit as number) : FEED_ITEMS_DEFAULT_LIMIT;
    return Math.min(FEED_ITEMS_MAX_LIMIT, Math.max(1, n));
}
