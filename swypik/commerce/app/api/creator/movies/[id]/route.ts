import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { rateLimit } from "@/lib/security/rate-limit";
import { getSeriesById, listEpisodes, updateSeries } from "@/lib/movies/repository";
import { clampEpisodePriceCents } from "@/lib/movies/pricing";
import { MOVIES_MAX_FREE_EPISODES } from "@/lib/movies/config";
import { MOVIE_GENRES } from "@/lib/movies/genres";
import { httpsUrl } from "@/lib/movies/license";
import { seriesEditNeedsReview } from "@/lib/movies/review";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    synopsis: z.string().trim().max(2000).optional(),
    genres: z.array(z.enum(MOVIE_GENRES)).max(5).optional(),
    coverUrl: httpsUrl.nullable().optional(),
    posterUrl: httpsUrl.nullable().optional(),
    freeEpisodes: z.coerce.number().int().min(0).max(MOVIES_MAX_FREE_EPISODES).optional(),
    episodePriceCents: z.coerce.number().int().nullable().optional(),
    isAdult: z.boolean().optional(),
    licenseNote: z.string().trim().max(1000).nullable().optional(),
    /** Creatorul poate doar trimite la review sau retrage în draft; publicarea e a adminului. */
    status: z.enum(["draft", "pending_review"]).optional(),
});

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const series = await getSeriesById(id);
    if (!series || series.owner_user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series, episodes: await listEpisodes(id) });
});

export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const rl = await rateLimit("creatorVideoEdit", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const { id } = await params;
    const parsed = parseBody(PatchSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const patch = {
        ...parsed.data,
        ...(parsed.data.episodePriceCents !== undefined
            ? { episodePriceCents: parsed.data.episodePriceCents !== null ? clampEpisodePriceCents(parsed.data.episodePriceCents) : null }
            : {}),
    };
    const current = await getSeriesById(id);
    if (!current || current.owner_user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (patch.status === "pending_review" && !(current.license_note ?? patch.licenseNote)) {
        return NextResponse.json({ error: "license_note_required" }, { status: 422 });
    }
    // Un titlu publicat editat (poster, titlu, 18+, episoade gratuite…) iese din catalog până la re-aprobare.
    const reReview = seriesEditNeedsReview(current, patch) && patch.status !== "draft";
    const series = await updateSeries(id, userId, reReview ? { ...patch, status: "pending_review" } : patch);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series, reReview });
});
