import { NextResponse } from "next/server";
import { constraintError } from "@/lib/movies/pg-errors";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { addEpisode, getSeriesById, listEpisodes, ownsReadyVideo } from "@/lib/movies/repository";
import { MOVIES_MAX_EPISODE_DURATION_MS } from "@/lib/movies/config";

export const dynamic = "force-dynamic";

const MAX_EPISODE_NUMBER = 500;

const BodySchema = z.object({
    videoId: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    episodeNumber: z.coerce.number().int().min(1).max(MAX_EPISODE_NUMBER).optional(),
});

export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const series = await getSeriesById(id);
    if (!series || series.owner_user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const video = await ownsReadyVideo(userId, parsed.data.videoId);
    if (!video) return NextResponse.json({ error: "video_not_ready_or_not_owned" }, { status: 422 });
    if (video.duration_ms && video.duration_ms > MOVIES_MAX_EPISODE_DURATION_MS) {
        return NextResponse.json({ error: "episode_too_long", maxDurationMs: MOVIES_MAX_EPISODE_DURATION_MS }, { status: 422 });
    }
    const existing = await listEpisodes(id);
    const episodeNumber = parsed.data.episodeNumber ?? (existing.at(-1)?.episode_number ?? 0) + 1;
    if (existing.some((e) => e.episode_number === episodeNumber)) return NextResponse.json({ error: "episode_number_taken" }, { status: 409 });
    if (existing.some((e) => e.video_id === parsed.data.videoId)) return NextResponse.json({ error: "video_already_used" }, { status: 409 });

    try {
        const episode = await addEpisode({ seriesId: id, episodeNumber, videoId: parsed.data.videoId, title: parsed.data.title, durationMs: video.duration_ms });
        return NextResponse.json({ episode }, { status: 201 });
    } catch (err) {
        // Cursă: același număr / același video atașat în paralel (UNIQUE) → 409.
        const mapped = constraintError(err);
        if (mapped) return NextResponse.json({ error: mapped.error }, { status: mapped.status });
        throw err;
    }
});
