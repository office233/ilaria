import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logAdminAction } from "@/lib/security/admin-audit";
import { listSeriesForAdmin } from "@/lib/movies/repository";
import { createIngestedTitle } from "@/lib/movies/admin-repository";
import { importEpisodeFromUrl } from "@/lib/movies/ingest-media";
import { validateIngest } from "@/lib/movies/ingest";
import { slugifySeriesTitle } from "@/lib/movies/slug";
import type { SeriesStatus } from "@/lib/movies/types";

export const dynamic = "force-dynamic";
const STATUSES: SeriesStatus[] = ["draft", "pending_review", "published", "archived"];

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const raw = new URL(req.url).searchParams.get("status");
    const status = STATUSES.includes(raw as SeriesStatus) ? (raw as SeriesStatus) : undefined;
    return NextResponse.json({ series: await listSeriesForAdmin(status) });
});

/**
 * POST /api/admin/movies — ingest de titlu licențiat (ciornă, cont oficial).
 * Licența e obligatorie; `publishBlockers` spune ce mai lipsește până la
 * publicare. Cu `mediaUrl`, fișierul intră în pipeline-ul de transcodare ca
 * episodul 1.
 */
export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const rl = await rateLimit("moviesIngest", auth.userId ?? getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const v = validateIngest(await req.json().catch(() => null));
    if (!v.ok) return NextResponse.json({ error: "invalid_body", detail: v.error }, { status: 400 });

    const series = await createIngestedTitle(v.data, slugifySeriesTitle(v.data.title), auth.userId);
    const imported = v.data.mediaUrl
        ? await importEpisodeFromUrl({ series, episodeNumber: 1, title: v.data.title, mediaUrl: v.data.mediaUrl })
        : null;

    await logAdminAction({
        action: "movie_series.ingest",
        targetType: "movie_series",
        targetId: series.id,
        details: { license: v.data.license.type, format: v.data.format, mediaUrl: v.data.mediaUrl, videoId: imported?.videoId ?? null },
        req,
    });
    return NextResponse.json(
        { series, episode: imported?.episode ?? null, queued: imported?.queued ?? false, publishBlockers: v.publishBlockers },
        { status: 201 },
    );
});
