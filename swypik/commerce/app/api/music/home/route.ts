import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { MUSIC_HOME_ROW_MAX } from "@/lib/music/config";
import { listTracks, ensureLikedPlaylist, listPlaylistTracks, listPlaylists, getLikedTrackIds } from "@/lib/music/repository";
import { toTrackDto } from "@/lib/music/dto";
import { buildMusicViewer } from "@/lib/music/viewer";
import { buildMusicHomeRows } from "@/lib/music/home";
import { logger } from "@/lib/logger";
import type { TrackDto } from "@/lib/music/types";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

const TRENDING_POOL = 60;

/** Tot ce are nevoie pagina /music într-o singură cerere: featured + rânduri. */
export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const rl = await rateLimit("musicCatalog", getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const user = await getAuthUser();
    const viewer = await buildMusicViewer(user.userId, user.isAdmin);

    let trending: TrackDto[] = [];
    let latest: TrackDto[] = [];
    let liked: TrackDto[] = [];
    let playlists: { id: string; title: string; trackCount: number }[] = [];

    try {
        const [trendingRows, latestRows, likedRows, playlistRows] = await Promise.all([
            listTracks({ sort: "trending", limit: TRENDING_POOL, offset: 0 }),
            listTracks({ sort: "new", limit: MUSIC_HOME_ROW_MAX, offset: 0 }),
            user.userId ? ensureLikedPlaylist(user.userId).then((id) => listPlaylistTracks(id)) : Promise.resolve([]),
            user.userId ? listPlaylists(user.userId) : Promise.resolve([]),
        ]);

        const allIds = [...trendingRows, ...latestRows, ...likedRows].map((t) => t.id);
        const likedIds = user.userId ? await getLikedTrackIds(user.userId, allIds) : new Set<string>();

        trending = trendingRows.map((t) => toTrackDto(t, viewer, likedIds.has(t.id)));
        latest = latestRows.map((t) => toTrackDto(t, viewer, likedIds.has(t.id)));
        liked = likedRows.map((t) => toTrackDto(t, viewer, likedIds.has(t.id)));
        playlists = playlistRows.filter((p) => !p.is_liked_list).map((p) => ({ id: p.id, title: p.title, trackCount: p.track_count }));
    } catch (err) {
        // Catalog indisponibil: rândurile rămân goale (UI-ul arată „catalog în pregătire"),
        // fără să le umplem cu radiouri/surse externe reetichetate drept „top" sau „originale".
        logger.warn({ err }, "[music/home] catalog query failed");
    }

    const rows = buildMusicHomeRows({
        top: trending,
        latest,
        liked,
        playlists,
    });

    // Anonim → edge (identic pentru toți); logat → „Îmi plac”/playlist-uri → private.
    return applyCachePolicy(NextResponse.json({ featured: trending[0] ?? null, rows }), "music/home", req);
});
