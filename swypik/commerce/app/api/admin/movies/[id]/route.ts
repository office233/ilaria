import { NextResponse } from "next/server";
import { constraintError } from "@/lib/movies/pg-errors";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { logAdminAction } from "@/lib/security/admin-audit";
import { getSeriesById, listEpisodes, updateSeries } from "@/lib/movies/repository";
import { episodeReadiness, updateSeriesLicense } from "@/lib/movies/admin-repository";
import { LicenseInputSchema, licenseColumns, licenseProblems } from "@/lib/movies/license";
import { clampEpisodePriceCents } from "@/lib/movies/pricing";
import { MOVIES_MAX_FREE_EPISODES } from "@/lib/movies/config";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
    status: z.enum(["draft", "pending_review", "published", "archived"]).optional(),
    freeEpisodes: z.coerce.number().int().min(0).max(MOVIES_MAX_FREE_EPISODES).optional(),
    episodePriceCents: z.coerce.number().int().nullable().optional(),
    isAdult: z.boolean().optional(),
    trailerVideoId: z.string().uuid().nullable().optional(),
    license: LicenseInputSchema.optional(),
});

const UUID = z.string().uuid();

export const GET = withErrorHandling(async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const series = await getSeriesById(id);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series, episodes: await listEpisodes(id), publishBlockers: licenseProblems(series) });
});

export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const parsed = parseBody(PatchSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { license, ...rest } = parsed.data;

    const current = await getSeriesById(id);
    if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });

    if (rest.status === "published") {
        // Publicarea cere: licență completă și valabilă pe teritoriul serviciului,
        // cel puțin un episod, toate episoadele aprobate la moderare și gata.
        const blockers = licenseProblems(license ? licenseColumns(license) : current);
        if (blockers.length > 0) return NextResponse.json({ error: "license_incomplete", blockers }, { status: 422 });
        const { total, approved } = await episodeReadiness(id);
        if (total === 0) return NextResponse.json({ error: "no_episodes" }, { status: 422 });
        if (total !== approved) return NextResponse.json({ error: "episodes_not_approved" }, { status: 422 });
    }
    if (license) await updateSeriesLicense(id, license, auth.userId);

    const patch = {
        ...rest,
        ...(rest.episodePriceCents !== undefined
            ? { episodePriceCents: rest.episodePriceCents !== null ? clampEpisodePriceCents(rest.episodePriceCents) : null }
            : {}),
    };
    let series;
    try {
        series = await updateSeries(id, null, patch);
    } catch (err) {
        // trailerVideoId inexistent (FK) / conflict → 4xx, nu 500.
        const mapped = constraintError(err);
        if (mapped) return NextResponse.json({ error: mapped.error }, { status: mapped.status });
        throw err;
    }
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await logAdminAction({ action: "movie_series.update", targetType: "movie_series", targetId: id, details: { ...patch, license: license?.type }, req });
    return NextResponse.json({ series, publishBlockers: licenseProblems(series) });
});
