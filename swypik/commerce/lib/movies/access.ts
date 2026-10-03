import type { MovieEpisodeRow, MovieSeriesRow, ViewerContext } from "./types";
import { isLicenseExpired } from "./license";

/** Titlul e vizibil public: publicat și cu licența încă valabilă (expirarea ascunde titlul automat). */
export function isSeriesPublic(
    series: Pick<MovieSeriesRow, "status"> & { license_expires_at?: string | null },
    now: number = Date.now(),
): boolean {
    return series.status === "published" && !isLicenseExpired(series.license_expires_at ?? null, now);
}

export function isFreeEpisode(
    series: Pick<MovieSeriesRow, "free_episodes">,
    episode: Pick<MovieEpisodeRow, "episode_number">,
): boolean {
    return episode.episode_number <= series.free_episodes;
}

export function lockedEpisodeCount(series: Pick<MovieSeriesRow, "free_episodes">, totalEpisodes: number): number {
    return Math.max(0, totalEpisodes - series.free_episodes);
}

/** Singura regulă de acces la un episod; folosită de play, stream și feed. */
export function canPlay(
    viewer: ViewerContext,
    series: Pick<MovieSeriesRow, "free_episodes" | "owner_user_id">,
    episode: Pick<MovieEpisodeRow, "id" | "episode_number">,
): boolean {
    if (isFreeEpisode(series, episode)) return true;
    if (viewer.isAdmin) return true;
    if (viewer.userId && viewer.userId === series.owner_user_id) return true;
    if (viewer.hasSeasonUnlock) return true;
    return viewer.unlockedEpisodeIds.has(episode.id);
}
