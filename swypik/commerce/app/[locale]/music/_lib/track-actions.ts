"use client";

/**
 * Acțiuni client mici, partajate între paginile publice Music, care nu au
 * nevoie de un modul dedicat în components/music/: like optimist și
 * construirea listei de piese pentru "shuffle". Fiecare pagină își gestionează
 * singură starea locală (lista de piese afișată) — funcțiile de aici doar
 * vorbesc cu API-ul și întorc rezultatul.
 */
import type { TrackDto } from "@/lib/music/types";

/** POST/DELETE pe like — apelantul face update optimist pe starea locală. */
export async function setTrackLiked(trackSlug: string, liked: boolean): Promise<boolean> {
    try {
        const res = await fetch(`/api/music/tracks/${trackSlug}/like`, { method: liked ? "POST" : "DELETE" });
        return res.ok;
    } catch {
        return false;
    }
}

/** Amestecă o listă de piese (Fisher–Yates) fără să modifice array-ul original — folosit de „Shuffle". */
export function shuffleTracks(tracks: readonly TrackDto[]): TrackDto[] {
    const out = tracks.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
