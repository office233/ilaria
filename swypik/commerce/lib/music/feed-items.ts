/**
 * Piesele Swypik Music ca carduri pentru feed-ul Home (consumate de
 * agregatorul feed-ului). Doar catalogul propriu, publicat și GRATUIT —
 * piesele premium nu au URL public și nu intră în feed; conținutul pentru
 * copii nu intră în feed-ul general. Sursele externe (radio, Audius, Jamendo)
 * nu apar în feed: nu au licență comercială garantată pentru un feed monetizat.
 */
import { clampFeedLimit, type FeedItemsOptions, type ModuleFeedCard } from "@/lib/media/feed-card";
import { isCommercialLicense } from "@/lib/audio/license";
import { MUSIC_AUDIO_TRACK_LICENSE } from "./config";
import { listTracks, type TrackListItem } from "./repository";

/** Mapare pură rând → card; null pentru piesele care nu pot apărea în feed. */
export function toMusicFeedCard(t: TrackListItem): ModuleFeedCard | null {
    if (t.status !== "published" || t.is_premium || !t.public_url || t.audience !== "general") return null;
    return {
        kind: "music_track",
        id: t.id,
        title: t.title,
        subtitle: t.artist.stage_name,
        image: t.cover_url ?? t.artist.cover_url ?? t.artist.avatar_url,
        href: `/music/track/${t.slug}`,
        media: { type: "audio", url: t.public_url, durationMs: t.duration_ms },
        isFree: true,
        genres: [t.genre],
        attribution: null,
        // Catalogul propriu: artistul a acordat licența la upload.
        licensedForCommercial: isCommercialLicense(MUSIC_AUDIO_TRACK_LICENSE),
        publishedAt: t.published_at,
    };
}

export async function getMusicFeedItems(opts: FeedItemsOptions = {}): Promise<ModuleFeedCard[]> {
    const limit = clampFeedLimit(opts.limit);
    // Supra-eșantionăm: piesele premium se filtrează după.
    const rows = await listTracks({ sort: "new", limit: limit * 2, offset: 0, audience: "general" });
    return rows.map(toMusicFeedCard).filter((c): c is ModuleFeedCard => c !== null).slice(0, limit);
}
