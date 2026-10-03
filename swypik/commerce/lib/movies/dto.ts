import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import { canPlay, isFreeEpisode } from "./access";
import { isPrivateKey, keyOf, PUBLIC_HLS_PREFIX } from "@/lib/media/private-media";
import { seasonPriceCents } from "./pricing";
import { MOVIES_SEASON_DISCOUNT_PCT } from "./config";
import { publicAttribution } from "./license";
import type { EpisodeDto, MovieEpisodeWithThumb, MovieProgressRow, MovieSeriesRow, SeriesDto, ViewerContext } from "./types";

export function toSeriesDto(series: MovieSeriesRow, episodeCount: number, ownerName: string | null): SeriesDto {
    return {
        id: series.id,
        slug: series.slug,
        title: series.title,
        synopsis: series.synopsis,
        genres: series.genres,
        coverUrl: series.cover_url,
        posterUrl: series.poster_url,
        trailerVideoId: series.trailer_video_id,
        freeEpisodes: series.free_episodes,
        episodePriceCents: series.episode_price_cents,
        seasonPriceCents: seasonPriceCents(series, episodeCount),
        seasonDiscountPct: MOVIES_SEASON_DISCOUNT_PCT,
        isAdult: series.is_adult,
        episodeCount,
        owner: { id: series.owner_user_id, name: ownerName ?? "Swypik", isOfficial: series.owner_user_id === SWYPIK_OFFICIAL_ID },
        format: series.format ?? "series",
        attribution: publicAttribution({
            license_type: series.license_type ?? null,
            attribution_text: series.attribution_text ?? null,
            license_source_url: series.license_source_url ?? null,
            license_territories: series.license_territories ?? [],
            license_expires_at: series.license_expires_at ?? null,
        }),
    };
}

/**
 * Thumbnail-ul unui episod, doar dacă NU dezvăluie directorul media: niciodată
 * din prefixul privat și, la episoadele plătite, niciodată din `videos/hls/`
 * (acolo stă și `master.m3u8`). `ensureEpisodeMediaPrivate` îl copiază la o
 * cheie publică aleatoare; până atunci episodul se afișează fără thumbnail.
 */
export function publicEpisodeThumbnail(url: string | null, paid: boolean): string | null {
    if (!url) return null;
    const key = keyOf(url);
    if (!key) return url;
    if (isPrivateKey(key)) return null;
    if (paid && key.startsWith(PUBLIC_HLS_PREFIX)) return null;
    return url;
}

export function toEpisodeDtos(series: MovieSeriesRow, episodes: MovieEpisodeWithThumb[], viewer: ViewerContext, progress: MovieProgressRow[]): EpisodeDto[] {
    const byEpisode = new Map(progress.map((p) => [p.episode_id, p]));
    return episodes.map((e) => {
        const p = byEpisode.get(e.id);
        return {
            id: e.id,
            number: e.episode_number,
            title: e.title,
            durationMs: e.duration_ms,
            thumbnailUrl: publicEpisodeThumbnail(e.thumbnail_url, !isFreeEpisode(series, e)),
            locked: !canPlay(viewer, series, e),
            priceCents: series.episode_price_cents,
            progress: p ? { positionMs: p.position_ms, completed: p.completed } : null,
        };
    });
}
