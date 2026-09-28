/**
 * Compunerea rândurilor paginii /movies (stil Netflix), funcție pură:
 * continuă → lista mea → top 10 → originale → noutăți → câte un rând per gen.
 * Rândurile goale nu apar. Ordinea genurilor = ordinea primei apariții în trending.
 */
import { MOVIE_GENRES, isMovieGenre, type MovieGenre } from "./genres";
import type { SeriesDto } from "./types";

export const HOME_TOP_COUNT = 10;
export const HOME_ROW_MAX = 20;

export type ContinueWatchingItem = { series: SeriesDto; episodeNumber: number; positionMs: number; durationMs: number | null };

export type HomeRow =
    | { kind: "continue"; items: ContinueWatchingItem[] }
    | { kind: "mylist"; items: SeriesDto[] }
    | { kind: "top10"; items: SeriesDto[] }
    | { kind: "originals"; items: SeriesDto[] }
    | { kind: "latest"; items: SeriesDto[] }
    | { kind: "genre"; genre: MovieGenre; items: SeriesDto[] };

export type HomeInput = {
    trending: SeriesDto[];
    latest: SeriesDto[];
    continueWatching: ContinueWatchingItem[];
    watchlist: SeriesDto[];
};

export function buildHomeRows(input: HomeInput): HomeRow[] {
    const rows: HomeRow[] = [];
    if (input.continueWatching.length) rows.push({ kind: "continue", items: input.continueWatching });
    if (input.watchlist.length) rows.push({ kind: "mylist", items: input.watchlist.slice(0, HOME_ROW_MAX) });
    if (input.trending.length) rows.push({ kind: "top10", items: input.trending.slice(0, HOME_TOP_COUNT) });

    const originals = input.trending.filter((s) => s.owner.isOfficial).slice(0, HOME_ROW_MAX);
    if (originals.length) rows.push({ kind: "originals", items: originals });
    if (input.latest.length) rows.push({ kind: "latest", items: input.latest.slice(0, HOME_ROW_MAX) });

    // Genuri în ordinea primei apariții în trending; fiecare serial poate fi în mai multe rânduri.
    const order: MovieGenre[] = [];
    for (const s of input.trending) for (const g of s.genres) if (isMovieGenre(g) && !order.includes(g)) order.push(g);
    for (const g of MOVIE_GENRES) if (!order.includes(g)) order.push(g);
    for (const genre of order) {
        const items = input.trending.filter((s) => s.genres.includes(genre)).slice(0, HOME_ROW_MAX);
        if (items.length) rows.push({ kind: "genre", genre, items });
    }
    return rows;
}
