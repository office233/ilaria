import { getTrackBySlug } from "./repository";

/** Piesa pentru pagina publică `/music/track/<slug>` — doar publicată; altfel null (→ 404 real). */
export async function resolvePublishedTrack(slug: string) {
    const track = await getTrackBySlug(slug).catch(() => null);
    if (!track || track.status !== "published") return null;
    return {
        title: track.title,
        coverUrl: track.cover_url,
        genre: track.genre,
        durationMs: track.duration_ms,
        artist: { slug: track.artist.slug, stageName: track.artist.stage_name },
    };
}
