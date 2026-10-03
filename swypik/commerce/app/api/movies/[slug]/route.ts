import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { dbQuery } from "@/lib/db";
import { getSeriesBySlug, listEpisodes, getProgress, isInWatchlist } from "@/lib/movies/repository";
import { isSeriesPublic } from "@/lib/movies/access";
import { buildViewerContext } from "@/lib/movies/viewer";
import { toSeriesDto, toEpisodeDtos } from "@/lib/movies/dto";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const { slug } = await params;

    const series = await getSeriesBySlug(slug);
    const user = await getAuthUser();
    const isOwner = Boolean(user.userId && series && series.owner_user_id === user.userId);
    if (!series || (!isSeriesPublic(series) && !user.isAdmin && !isOwner)) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const [episodes, viewer, progress, ownerRows, inWatchlist] = await Promise.all([
        listEpisodes(series.id, { publishedOnly: !user.isAdmin && !isOwner }),
        buildViewerContext(user.userId, user.isAdmin, series.id),
        user.userId ? getProgress(user.userId, series.id) : Promise.resolve([]),
        dbQuery<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [series.owner_user_id]),
        user.userId ? isInWatchlist(user.userId, series.id) : Promise.resolve(false),
    ]);
    return NextResponse.json({
        series: toSeriesDto(series, episodes.length, ownerRows.rows[0]?.display_name ?? null),
        episodes: toEpisodeDtos(series, episodes, viewer, progress),
        viewer: { isAuthed: Boolean(user.userId), hasSeasonUnlock: viewer.hasSeasonUnlock, isOwner, inWatchlist },
    });
});
