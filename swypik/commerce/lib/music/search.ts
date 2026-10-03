import type { TrackDto } from "./types";

/** Catalog Swypik primul, apoi surse externe, fără dubluri de id. Pur (și în client). */
export function mergeSearchResults(own: TrackDto[], external: TrackDto[]): TrackDto[] {
    const seen = new Set<string>();
    return [...own, ...external].filter((tr) => {
        if (seen.has(tr.id)) return false;
        seen.add(tr.id);
        return true;
    });
}
