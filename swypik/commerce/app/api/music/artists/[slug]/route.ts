import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import {
    getArtistBySlug,
    listArtistTracks,
    listArtistAlbums,
    listAlbumTracks,
    countReelsUsingArtist,
    getLikedTrackIds,
} from "@/lib/music/repository";
import { buildMusicViewer } from "@/lib/music/viewer";
import { toArtistDto, toTrackDto, toAlbumDto } from "@/lib/music/dto";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const { slug } = await params;
    let artist = null;
    try {
        artist = await getArtistBySlug(slug);
    } catch {
        artist = null;
    }
    if (!artist) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const user = await getAuthUser();
    const viewer = await buildMusicViewer(user.userId, user.isAdmin);
    const isOwner = user.userId === artist.user_id;
    const publishedOnly = !(user.isAdmin || isOwner);

    const [tracks, albums, reelsCount] = await Promise.all([
        listArtistTracks(artist.user_id, publishedOnly),
        listArtistAlbums(artist.user_id, publishedOnly),
        countReelsUsingArtist(artist.user_id),
    ]);
    const likedIds = user.userId ? await getLikedTrackIds(user.userId, tracks.map((t) => t.id)) : new Set<string>();
    const albumDtos = await Promise.all(
        albums.map(async (album) => toAlbumDto(album, await listAlbumTracks(album.id, publishedOnly), viewer)),
    );

    return NextResponse.json({
        artist: toArtistDto(artist),
        tracks: tracks.map((t) => toTrackDto(t, viewer, likedIds.has(t.id))),
        albums: albumDtos,
        reelsCount,
    });
});
