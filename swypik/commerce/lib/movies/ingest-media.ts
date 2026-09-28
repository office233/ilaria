/**
 * Importul unui fișier video licențiat ca episod: aceeași cale ca uploadurile
 * creatorilor (videos → video_assets → job de transcodare HLS), apoi rândul
 * `movie_episodes`. Episodul rămâne privat cât timp titlul nu e publicat
 * (syncEpisodeVisibility + trigger-ul DB), iar publicarea cere ca videoul să
 * fie gata și aprobat la moderare.
 */
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import { enqueueVideoPipeline } from "@/lib/video/pipeline";
import { addEpisode } from "./repository";
import { enqueuePrivateEpisodeTranscode } from "./private-ingest";
import type { MovieEpisodeRow, MovieSeriesRow } from "./types";

export async function importEpisodeFromUrl(args: {
    series: Pick<MovieSeriesRow, "id" | "title" | "license_type" | "license_source_url" | "free_episodes">;
    episodeNumber: number;
    title: string;
    mediaUrl: string;
}): Promise<{ episode: MovieEpisodeRow; videoId: string; queued: boolean }> {
    const metadata = {
        vertical: "movies",
        seriesId: args.series.id,
        license: args.series.license_type,
        license_source_url: args.series.license_source_url,
    };
    // Episod plătit → transcodat direct în prefixul privat (P0: niciodată public).
    const paid = args.episodeNumber > args.series.free_episodes;
    const job = paid
        ? await enqueuePrivateEpisodeTranscode({ sourceUrl: args.mediaUrl, title: args.title, creatorId: SWYPIK_OFFICIAL_ID, metadata })
        : await enqueueVideoPipeline({ sourceUrl: args.mediaUrl, title: args.title, creatorId: SWYPIK_OFFICIAL_ID, tags: ["movies"], metadata });
    const episode = await addEpisode({
        seriesId: args.series.id,
        episodeNumber: args.episodeNumber,
        videoId: job.videoId,
        title: args.title,
        durationMs: null,
    });
    return { episode, videoId: job.videoId, queued: job.queued };
}
