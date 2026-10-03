import { NextResponse } from "next/server";
import { isNativeAppRequest, PURCHASE_UNAVAILABLE_IN_APP } from "@/lib/media/native-app";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { getSeriesBySlug } from "@/lib/movies/repository";
import { createEpisodeUnlockIntent, createSeasonUnlockIntent } from "@/lib/movies/unlock";
import { getUnlockStatus } from "@/lib/movies/unlock-status";

export const dynamic = "force-dynamic";

const BodySchema = z.union([
    z.object({ episodeId: z.string().uuid() }),
    z.object({ season: z.literal(true) }),
]);

const StatusQuerySchema = z.object({ episodeId: z.string().uuid().optional() });

/**
 * GET /api/movies/[slug]/unlock?episodeId=… (fără episodeId = sezonul):
 * starea deblocării pentru userul curent — clientul o interoghează după
 * confirmarea plății, până când webhook-ul Stripe o marchează `paid`.
 */
export const GET = withErrorHandling(async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("moviesProgress", user.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const parsed = StatusQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    const { slug } = await params;
    const series = await getSeriesBySlug(slug);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const status = await getUnlockStatus(user.userId, series.id, parsed.data.episodeId ?? null);
    return NextResponse.json({ status }, { headers: { "cache-control": "private, no-store" } });
});

const FAILURE_STATUS = {
    not_found: 404,
    already_free: 409,
    series_not_published: 404,
    price_not_set: 409,
} as const;

/**
 * Deblocare cu cardul (Stripe, RON): întoarce un `clientSecret` de PaymentIntent
 * pe care clientul îl confirmă cu Stripe Elements (vezi `UnlockButton`/`PaywallSlide`).
 * Accesul se acordă abia la webhook-ul `payment_intent.succeeded`.
 */
export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    // Shell-ul nativ: deblocările digitale nu se vând în afara IAP (App Store 3.1.1 / Play Payments).
    if (isNativeAppRequest(req)) return NextResponse.json({ error: PURCHASE_UNAVAILABLE_IN_APP }, { status: 403 });
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("moviesUnlock", user.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { slug } = await params;
    const series = await getSeriesBySlug(slug);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const result = "episodeId" in parsed.data
        ? await createEpisodeUnlockIntent({ userId: user.userId, episodeId: parsed.data.episodeId, seriesId: series.id })
        : await createSeasonUnlockIntent({ userId: user.userId, seriesId: series.id });

    if (!result.ok) {
        return NextResponse.json({ error: result.reason }, { status: FAILURE_STATUS[result.reason] });
    }
    if (result.alreadyUnlocked) {
        return NextResponse.json({ alreadyUnlocked: true });
    }
    return NextResponse.json({ alreadyUnlocked: false, clientSecret: result.clientSecret, amountCents: result.amountCents });
});
