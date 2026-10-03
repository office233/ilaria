import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { createSeries, isPublisher, listSeriesForOwner, creatorShareTotals } from "@/lib/movies/repository";
import { clampEpisodePriceCents } from "@/lib/movies/pricing";
import { slugifySeriesTitle } from "@/lib/movies/slug";
import { MOVIES_DEFAULT_EPISODE_PRICE_CENTS, MOVIES_DEFAULT_EPISODE_PRICE_UNITS, MOVIES_DEFAULT_FREE_EPISODES, MOVIES_MAX_FREE_EPISODES } from "@/lib/movies/config";
import { LOCALES } from "@/lib/i18n/config";
import { MOVIE_GENRES } from "@/lib/movies/genres";
import { LicenseInputSchema, TERRITORY_WORLD } from "@/lib/movies/license";
import { updateSeriesLicense } from "@/lib/movies/admin-repository";

const CREATOR_LICENSE_TYPES = ["owned", "cc_by", "cc_by_sa"] as const;

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
    title: z.string().trim().min(2).max(120),
    synopsis: z.string().trim().max(2000).default(""),
    genres: z.array(z.enum(MOVIE_GENRES)).max(5).default([]),
    languageCode: z.enum(LOCALES).default("ro"),
    coverUrl: z.string().url().max(500).nullable().default(null),
    posterUrl: z.string().url().max(500).nullable().default(null),
    freeEpisodes: z.coerce.number().int().min(0).max(MOVIES_MAX_FREE_EPISODES).default(MOVIES_DEFAULT_FREE_EPISODES),
    episodePriceCents: z.coerce.number().int().nullable().default(MOVIES_DEFAULT_EPISODE_PRICE_CENTS),
    isAdult: z.boolean().default(false),
    licenseNote: z.string().trim().max(1000).nullable().default(null),
    /** Creatorii declară drepturile: producție proprie sau CC BY / BY-SA (NC nu poate sta în spatele unei plăți). */
    license: LicenseInputSchema.extend({ type: z.enum(CREATOR_LICENSE_TYPES) }).default({
        type: "owned", attributionText: null, sourceUrl: null, territories: [TERRITORY_WORLD], expiresAt: null,
    }),
    /** Bifa obligatorie: „dețin drepturile (inclusiv muzică, actori, locații)". */
    rightsConfirmed: z.literal(true),
});

export const GET = withErrorHandling(async function GET() {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const [publisher, series, earnings] = await Promise.all([isPublisher(userId), listSeriesForOwner(userId), creatorShareTotals(userId)]);
    return NextResponse.json({ publisher, series, earnings });
});

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isPublisher(userId))) return NextResponse.json({ error: "not_a_publisher" }, { status: 403 });
    const rl = await rateLimit("moviesPublish", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const parsed = parseBody(CreateSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const d = parsed.data;
    const series = await createSeries({
        ownerUserId: userId,
        slug: slugifySeriesTitle(d.title),
        title: d.title,
        synopsis: d.synopsis,
        genres: d.genres,
        languageCode: d.languageCode,
        coverUrl: d.coverUrl,
        posterUrl: d.posterUrl,
        freeEpisodes: d.freeEpisodes,
        // Legacy: coloana SWYP e NOT NULL în schema veche — scriem valoarea minimă (nefolosită de UI).
        episodePriceUnits: MOVIES_DEFAULT_EPISODE_PRICE_UNITS,
        episodePriceCents: d.episodePriceCents !== null ? clampEpisodePriceCents(d.episodePriceCents) : null,
        isAdult: d.isAdult,
        licenseNote: d.licenseNote,
    });
    await updateSeriesLicense(series.id, d.license, userId);
    return NextResponse.json({ series }, { status: 201 });
});
