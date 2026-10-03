/**
 * Re-moderare la editarea unei piese publicate (audit 2, P1): titlul,
 * coperta, licența, genul, eticheta explicit și publicul (kids) sunt văzute
 * de ascultători și sincronizate în sunetele din reels (`audio_tracks`), deci
 * nu se pot schimba nemoderat. O astfel de editare readuce piesa în
 * `pending_review` (status + moderare); sincronizarea îi dezactivează sunetul
 * din reels până la re-aprobare. Premium/preț/reels/album rămân editabile.
 */
import type { MusicTrackRow } from "./types";

type ReviewedField = "title" | "coverUrl" | "licenseNote" | "genre" | "explicit" | "audience";

const FIELD_COLUMN: Record<ReviewedField, keyof MusicTrackRow> = {
    title: "title",
    coverUrl: "cover_url",
    licenseNote: "license_note",
    genre: "genre",
    explicit: "explicit",
    audience: "audience",
};

export type TrackContentPatch = Partial<Record<ReviewedField, unknown>>;

/** Pur: piesa publicată trebuie re-moderată după această editare. */
export function trackEditNeedsReview(current: MusicTrackRow, patch: TrackContentPatch): boolean {
    if (current.status !== "published") return false;
    return (Object.keys(FIELD_COLUMN) as ReviewedField[]).some((field) => {
        const next = patch[field];
        return next !== undefined && JSON.stringify(next ?? null) !== JSON.stringify(current[FIELD_COLUMN[field]] ?? null);
    });
}
