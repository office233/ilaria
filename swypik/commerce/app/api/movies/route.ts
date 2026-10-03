import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { MOVIES_CATALOG_PAGE_SIZE } from "@/lib/movies/config";
import { listPublishedSeries, listContinueWatching } from "@/lib/movies/repository";
import { toSeriesDto } from "@/lib/movies/dto";
import { MOVIE_GENRES } from "@/lib/movies/genres";

export const dynamic = "force-dynamic";

const CONTINUE_WATCHING_LIMIT = 10;

const QuerySchema = z.object({
    genre: z.enum(MOVIE_GENRES).optional(),
    sort: z.enum(["trending", "new"]).default("trending"),
    page: z.coerce.number().int().min(0).max(1000).default(0),
});

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const rl = await rateLimit("moviesCatalog", getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    const { genre, sort, page } = parsed.data;

    const user = await getAuthUser();
    // MVP: doar adminul vede is_adult în catalog; gating-ul complet vine cu verificarea de vârstă.
    const includeAdult = user.isAdmin;
    const series = await listPublishedSeries({ genre, sort, limit: MOVIES_CATALOG_PAGE_SIZE, offset: page * MOVIES_CATALOG_PAGE_SIZE, includeAdult });
    const continueWatching = user.userId ? await listContinueWatching(user.userId, CONTINUE_WATCHING_LIMIT) : [];

    const items = series.map((s) => toSeriesDto(s, s.episode_count, s.owner_name));

    return NextResponse.json({
        items,
        continueWatching: continueWatching.map((c) => ({
            series: toSeriesDto(c.series, 0, null),
            episodeNumber: c.episode.episode_number,
            positionMs: c.position_ms,
            durationMs: c.episode.duration_ms,
        })),
        nextPage: series.length === MOVIES_CATALOG_PAGE_SIZE ? page + 1 : null,
    });
});
