import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { logAdminAction } from "@/lib/security/admin-audit";
import { addEpisode, getSeriesById, listEpisodes } from "@/lib/movies/repository";
import { isVideoAttached, readyApprovedVideo } from "@/lib/movies/admin-repository";
import { importEpisodeFromUrl } from "@/lib/movies/ingest-media";
import { IngestEpisodeSchema } from "@/lib/movies/ingest";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/movies/[id]/episodes — atașează un episod la un titlu:
 * fie un video existent (gata + aprobat; adminul nu e limitat la propriile
 * clipuri și nici la durata maximă a micro-episoadelor — filmele sunt lungi),
 * fie un fișier https importat prin pipeline-ul de transcodare.
 */
export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const rl = await rateLimit("moviesIngest", auth.userId ?? getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { id } = await params;
    const series = await getSeriesById(id);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const parsed = parseBody(IngestEpisodeSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const d = parsed.data;

    const existing = await listEpisodes(id);
    const episodeNumber = d.episodeNumber ?? (existing.at(-1)?.episode_number ?? 0) + 1;
    if (existing.some((e) => e.episode_number === episodeNumber)) return NextResponse.json({ error: "episode_number_taken" }, { status: 409 });

    let result: { episodeId: string; videoId: string; queued: boolean };
    if (d.videoId) {
        const video = await readyApprovedVideo(d.videoId);
        if (!video) return NextResponse.json({ error: "video_not_ready_or_not_approved" }, { status: 422 });
        if (await isVideoAttached(d.videoId)) return NextResponse.json({ error: "video_already_used" }, { status: 409 });
        const episode = await addEpisode({ seriesId: id, episodeNumber, videoId: d.videoId, title: d.title, durationMs: video.duration_ms });
        result = { episodeId: episode.id, videoId: d.videoId, queued: false };
    } else {
        const imported = await importEpisodeFromUrl({ series, episodeNumber, title: d.title, mediaUrl: d.mediaUrl! });
        result = { episodeId: imported.episode.id, videoId: imported.videoId, queued: imported.queued };
    }
    await logAdminAction({ action: "movie_episode.ingest", targetType: "movie_series", targetId: id, details: { ...result, episodeNumber }, req });
    return NextResponse.json(result, { status: 201 });
});
