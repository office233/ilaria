/**
 * Titlurile Movies ca carduri pentru feed-ul Home (consumate de agregatorul
 * feed-ului). Doar titluri publice (publicate + licență valabilă), fără adult
 * implicit. Clipul redabil din feed = episodul 1, numai dacă e gratuit — un
 * episod plătit nu ajunge niciodată în feed.
 */
import { dbQuery } from "@/lib/db";
import { clampFeedLimit, type FeedItemsOptions, type ModuleFeedCard } from "@/lib/media/feed-card";
import { listPublishedSeries } from "./repository";
import type { MovieSeriesRow } from "./types";

type SeriesForFeed = MovieSeriesRow & { owner_name: string | null };

/** Mapare pură rând → card (testabilă fără DB). */
export function toMovieFeedCard(s: SeriesForFeed, freeFirstEpisodeVideoId: string | null): ModuleFeedCard {
    return {
        kind: "movie_title",
        id: s.id,
        title: s.title,
        subtitle: s.owner_name,
        image: s.poster_url ?? s.cover_url,
        href: `/movies/${s.slug}`,
        media: freeFirstEpisodeVideoId ? { type: "video", videoId: freeFirstEpisodeVideoId } : null,
        isFree: s.free_episodes > 0,
        genres: s.genres,
        attribution: s.license_type === "cc_by" || s.license_type === "cc_by_sa" ? s.attribution_text : null,
        // Titlurile publice au trecut deja de verificarea licenței la publicare.
        licensedForCommercial: s.license_type !== null,
        publishedAt: s.published_at,
    };
}

/** Video-ul episodului 1 pentru fiecare titlu, doar unde ep. 1 e gratuit, publicat și public (media redabilă fără token). */
async function freeFirstEpisodes(seriesIds: string[]): Promise<Map<string, string>> {
    if (seriesIds.length === 0) return new Map();
    const { rows } = await dbQuery<{ series_id: string; video_id: string }>(
        `SELECT e.series_id, e.video_id
           FROM movie_episodes e JOIN movie_series s ON s.id = e.series_id JOIN videos v ON v.id = e.video_id
          WHERE e.series_id = ANY($1::uuid[]) AND e.episode_number = 1 AND e.status = 'published' AND s.free_episodes >= 1
            AND v.visibility = 'public'`,
        [seriesIds],
    );
    return new Map(rows.map((r) => [r.series_id, r.video_id]));
}

export async function getMovieFeedItems(opts: FeedItemsOptions = {}): Promise<ModuleFeedCard[]> {
    const series = await listPublishedSeries({ sort: "new", limit: clampFeedLimit(opts.limit), offset: 0, includeAdult: opts.includeAdult ?? false });
    const clips = await freeFirstEpisodes(series.map((s) => s.id));
    return series.map((s) => toMovieFeedCard(s, clips.get(s.id) ?? null));
}
