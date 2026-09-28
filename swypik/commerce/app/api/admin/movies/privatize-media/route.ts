import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { logAdminAction } from "@/lib/security/admin-audit";
import { privatizePaidEpisodeMedia } from "@/lib/movies/private-media";

export const dynamic = "force-dynamic";

const MAX_BATCH = 500;
const BodySchema = z.object({
    dryRun: z.boolean().default(true),
    limit: z.coerce.number().int().min(1).max(MAX_BATCH).default(200),
    seriesId: z.string().uuid().optional(),
});

/**
 * POST /api/admin/movies/privatize-media — migrarea one-shot (idempotentă) a
 * episoadelor plătite existente din prefixul public în cel privat (înlocuiește
 * `scripts/data/privatize-paid-episodes.mjs`). Implicit `dryRun: true` (doar
 * numără); cu `dryRun: false` mută câte `limit` episoade — se repetă până
 * `checked` devine 0. Cron-ul zilnic rulează aceeași trecere automat.
 */
export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const rl = await rateLimit("moviesIngest", auth.userId ?? getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const parsed = parseBody(BodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const report = await privatizePaidEpisodeMedia(parsed.data);
    if (!parsed.data.dryRun) {
        await logAdminAction({ action: "movie_media.privatize", targetType: "movie_series", targetId: parsed.data.seriesId ?? "all", details: report, req });
    }
    return NextResponse.json({ dryRun: parsed.data.dryRun, ...report });
});
