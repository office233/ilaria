import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { getAlbumBySlug, listAlbumTracks, getLikedTrackIds } from "@/lib/music/repository";
import { buildMusicViewer } from "@/lib/music/viewer";
import { toAlbumDto, toTrackDto } from "@/lib/music/dto";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const { slug } = await params;
    const album = await getAlbumBySlug(slug);
    const user = await getAuthUser();
    const isOwner = Boolean(user.userId && album && album.artist_user_id === user.userId);
    if (!album || (album.status !== "published" && !user.isAdmin && !isOwner)) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const viewer = await buildMusicViewer(user.userId, user.isAdmin);
    const tracks = await listAlbumTracks(album.id, !(user.isAdmin || isOwner));
    const likedIds = user.userId ? await getLikedTrackIds(user.userId, tracks.map((t) => t.id)) : new Set<string>();

    return NextResponse.json({
        album: toAlbumDto(album, tracks, viewer),
        tracks: tracks.map((t) => toTrackDto(t, viewer, likedIds.has(t.id))),
    });
});
