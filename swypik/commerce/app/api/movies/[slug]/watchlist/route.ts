import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { isSeriesPublic } from "@/lib/movies/access";
import { addToWatchlist, getSeriesBySlug, removeFromWatchlist } from "@/lib/movies/repository";

export const dynamic = "force-dynamic";

type Resolved = { response: Response } | { userId: string; seriesId: string };

async function resolve(req: Request, slug: string): Promise<Resolved> {
    if (!isEnabled("movies")) return { response: frozenResponse("movies") };
    const user = await getAuthUser();
    if (!user.userId) return { response: NextResponse.json({ error: "auth_required" }, { status: 401 }) };
    const rl = await rateLimit("moviesProgress", user.userId);
    if (!rl.success) return { response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };
    const series = await getSeriesBySlug(slug);
    if (!series || !isSeriesPublic(series)) return { response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
    return { userId: user.userId, seriesId: series.id };
}

export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const r = await resolve(req, slug);
    if ("response" in r) return r.response;
    await addToWatchlist(r.userId, r.seriesId);
    return NextResponse.json({ ok: true, inWatchlist: true });
});

export const DELETE = withErrorHandling(async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const r = await resolve(req, slug);
    if ("response" in r) return r.response;
    await removeFromWatchlist(r.userId, r.seriesId);
    return NextResponse.json({ ok: true, inWatchlist: false });
});
