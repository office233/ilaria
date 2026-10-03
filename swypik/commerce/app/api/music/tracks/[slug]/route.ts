import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { getTrackBySlug, getAlbumById, listAlbumTracks, getLikedTrackIds } from "@/lib/music/repository";
import { buildMusicViewer } from "@/lib/music/viewer";
import { toTrackDto, toAlbumDto } from "@/lib/music/dto";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const { slug } = await params;
    let track = null;
    try {
        track = await getTrackBySlug(slug);
    } catch {
        track = null;
    }
    const user = await getAuthUser();
    const isOwner = Boolean(user.userId && track && track.artist_user_id === user.userId);
    if (!track || (track.status !== "published" && !user.isAdmin && !isOwner)) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const viewer = await buildMusicViewer(user.userId, user.isAdmin);
    const [likedIds, album] = await Promise.all([
        user.userId ? getLikedTrackIds(user.userId, [track.id]) : Promise.resolve(new Set<string>()),
        track.album_id ? getAlbumById(track.album_id) : Promise.resolve(null),
    ]);
    const albumTracks = album ? await listAlbumTracks(album.id, !(user.isAdmin || isOwner)) : [];

    return NextResponse.json({
        track: toTrackDto(track, viewer, likedIds.has(track.id)),
        album: album ? toAlbumDto(album, albumTracks, viewer) : null,
        viewer: { requireAuth: !user.userId },
    });
});
