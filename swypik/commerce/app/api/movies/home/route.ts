import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { listPublishedSeries, listContinueWatching, listWatchlist } from "@/lib/movies/repository";
import { toSeriesDto } from "@/lib/movies/dto";
import { buildHomeRows, HOME_ROW_MAX } from "@/lib/movies/home";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

const TRENDING_POOL = 60;
const CONTINUE_LIMIT = 10;

/** Tot ce are nevoie pagina /movies într-o singură cerere: featured + rânduri. */
export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const rl = await rateLimit("moviesCatalog", getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const user = await getAuthUser();
    const includeAdult = user.isAdmin;
    const [trendingRows, latestRows, continueRows, watchlistRows] = await Promise.all([
        listPublishedSeries({ sort: "trending", limit: TRENDING_POOL, offset: 0, includeAdult }),
        listPublishedSeries({ sort: "new", limit: HOME_ROW_MAX, offset: 0, includeAdult }),
        user.userId ? listContinueWatching(user.userId, CONTINUE_LIMIT) : Promise.resolve([]),
        user.userId ? listWatchlist(user.userId, HOME_ROW_MAX) : Promise.resolve([]),
    ]);

    const trending = trendingRows.map((s) => toSeriesDto(s, s.episode_count, s.owner_name));

    const rows = buildHomeRows({
        trending,
        latest: latestRows.map((s) => toSeriesDto(s, s.episode_count, s.owner_name)),
        continueWatching: continueRows.map((c) => ({
            series: toSeriesDto(c.series, 0, null),
            episodeNumber: c.episode.episode_number,
            positionMs: c.position_ms,
            durationMs: c.episode.duration_ms,
        })),
        watchlist: watchlistRows.map((s) => toSeriesDto(s, s.episode_count, s.owner_name)),
    });

    // Anonim → edge (identic pentru toți); logat → „continuă”/watchlist personale → private.
    return applyCachePolicy(NextResponse.json({ featured: trending[0] ?? null, rows }), "movies/home", req);
});
