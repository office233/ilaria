/**
 * Compunerea rândurilor paginii /music (stil Movies), funcție pură:
 * top 10 → originale → noutăți → „Îmi plac" → playlist-urile mele → câte un
 * rând per gen. Rândurile goale nu apar. Ordinea genurilor = ordinea primei
 * apariții în `top`, apoi restul taxonomiei fixe.
 */
import { MUSIC_GENRES, isMusicGenre, type MusicGenre } from "./genres";
import { MUSIC_HOME_ROW_MAX, MUSIC_TOP_COUNT } from "./config";
import type { TrackDto } from "./types";

/** Rezumatul unui playlist pentru rândul de home — nu are nevoie de piesele efective. */
export type PlaylistSummary = { id: string; title: string; trackCount: number };

export type MusicHomeRow =
    | { kind: "top10"; items: TrackDto[] }
    | { kind: "originals"; items: TrackDto[] }
    | { kind: "latest"; items: TrackDto[] }
    | { kind: "liked"; items: TrackDto[] }
    | { kind: "genre"; genre: MusicGenre; items: TrackDto[] }
    | { kind: "playlists"; items: PlaylistSummary[] };

export type MusicHomeInput = {
    top: TrackDto[];
    latest: TrackDto[];
    liked: TrackDto[];
    playlists: PlaylistSummary[];
};

export function buildMusicHomeRows(input: MusicHomeInput): MusicHomeRow[] {
    const rows: MusicHomeRow[] = [];
    if (input.top.length) rows.push({ kind: "top10", items: input.top.slice(0, MUSIC_TOP_COUNT) });

    const originals = input.top.filter((t) => t.artist.isOfficial).slice(0, MUSIC_HOME_ROW_MAX);
    if (originals.length) rows.push({ kind: "originals", items: originals });
    if (input.latest.length) rows.push({ kind: "latest", items: input.latest.slice(0, MUSIC_HOME_ROW_MAX) });
    if (input.liked.length) rows.push({ kind: "liked", items: input.liked.slice(0, MUSIC_HOME_ROW_MAX) });
    if (input.playlists.length) rows.push({ kind: "playlists", items: input.playlists });

    // Genuri în ordinea primei apariții în top; fiecare piesă poate apărea în mai multe rânduri.
    const order: MusicGenre[] = [];
    for (const t of input.top) if (isMusicGenre(t.genre) && !order.includes(t.genre)) order.push(t.genre);
    for (const g of MUSIC_GENRES) if (!order.includes(g)) order.push(g);
    for (const genre of order) {
        const items = input.top.filter((t) => t.genre === genre).slice(0, MUSIC_HOME_ROW_MAX);
        if (items.length) rows.push({ kind: "genre", genre, items });
    }
    return rows;
}
