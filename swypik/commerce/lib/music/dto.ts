/**
 * Conversia rândurilor DB → DTO-uri publice. Niciodată `object_key`/`public_url`
 * nu ajung la client (redarea trece prin `/api/music/tracks/[slug]/play`).
 */
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import { canStream } from "./access";
import { albumPriceCents } from "./pricing";
import type { AlbumDto, ArtistDto, MusicAlbumRow, MusicArtistRow, MusicTrackRow, MusicViewer, TrackDto } from "./types";

export function toArtistDto(a: MusicArtistRow): ArtistDto {
    return {
        id: a.user_id,
        slug: a.slug,
        stageName: a.stage_name,
        bio: a.bio,
        avatarUrl: a.avatar_url,
        coverUrl: a.cover_url,
        isOfficial: a.user_id === SWYPIK_OFFICIAL_ID,
    };
}

export function toTrackDto(
    t: MusicTrackRow & { artist: MusicArtistRow; plays_7d?: number },
    viewer: MusicViewer,
    liked: boolean,
): TrackDto {
    return {
        id: t.id,
        slug: t.slug,
        title: t.title,
        coverUrl: t.cover_url,
        genre: t.genre,
        durationMs: t.duration_ms,
        explicit: t.explicit,
        isPremium: t.is_premium,
        priceCents: t.price_cents,
        locked: !canStream(viewer, t),
        allowReels: t.allow_reels,
        audioTrackId: t.audio_track_id,
        albumId: t.album_id,
        trackNumber: t.track_number,
        artist: toArtistDto(t.artist),
        plays7d: t.plays_7d ?? 0,
        liked,
    };
}

export function toAlbumDto(
    album: MusicAlbumRow & { artist: MusicArtistRow; track_count: number },
    tracks: Pick<MusicTrackRow, "is_premium" | "price_cents">[],
    viewer: MusicViewer,
): AlbumDto {
    const priceCents = albumPriceCents(album, tracks);
    const isOwner = Boolean(viewer.userId && viewer.userId === album.artist_user_id);
    // Blocat doar dacă are un preț RON real de plătit.
    const locked = priceCents !== null && priceCents > 0 && !viewer.unlockedAlbumIds.has(album.id) && !isOwner && !viewer.isAdmin;
    return {
        id: album.id,
        slug: album.slug,
        title: album.title,
        coverUrl: album.cover_url,
        releaseDate: album.release_date,
        priceCents,
        locked,
        artist: toArtistDto(album.artist),
        trackCount: album.track_count,
    };
}
