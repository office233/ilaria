/**
 * Re-review la editarea unui titlu publicat (audit 2, P1): creatorul nu poate
 * schimba nemoderat ce văd spectatorii (titlu, sinopsis, poster/copertă,
 * 18+, genuri, licență) și nici reduce episoadele gratuite după ce titlul a
 * fost aprobat. O astfel de editare trimite titlul înapoi în `pending_review`.
 * Prețul per episod rămâne editabil (plafonat de `clampEpisodePriceCents`).
 */
import type { MovieSeriesRow } from "./types";

type ReviewedField = "title" | "synopsis" | "genres" | "coverUrl" | "posterUrl" | "isAdult" | "licenseNote" | "freeEpisodes";

const FIELD_COLUMN: Record<ReviewedField, keyof MovieSeriesRow> = {
    title: "title",
    synopsis: "synopsis",
    genres: "genres",
    coverUrl: "cover_url",
    posterUrl: "poster_url",
    isAdult: "is_adult",
    licenseNote: "license_note",
    freeEpisodes: "free_episodes",
};

export type SeriesContentPatch = Partial<Record<ReviewedField, unknown>>;

/** Câmpurile moderate care se schimbă efectiv (valoare diferită de cea curentă). Pur. */
export function changedReviewedFields(current: MovieSeriesRow, patch: SeriesContentPatch): ReviewedField[] {
    return (Object.keys(FIELD_COLUMN) as ReviewedField[]).filter((field) => {
        const next = patch[field];
        if (next === undefined) return false;
        return JSON.stringify(next ?? null) !== JSON.stringify(current[FIELD_COLUMN[field]] ?? null);
    });
}

/** Titlul publicat trebuie re-aprobat după această editare. */
export function seriesEditNeedsReview(current: MovieSeriesRow, patch: SeriesContentPatch): boolean {
    return current.status === "published" && changedReviewedFields(current, patch).length > 0;
}
