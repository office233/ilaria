import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { addToPlaylist, ensureLikedPlaylist, getTrackBySlug, removeFromPlaylist } from "@/lib/music/repository";

export const dynamic = "force-dynamic";

type Resolved = { response: Response } | { userId: string; trackId: string };

async function resolve(slug: string): Promise<Resolved> {
    if (!isEnabled("music")) return { response: frozenResponse("music") };
    const user = await getAuthUser();
    if (!user.userId) return { response: NextResponse.json({ error: "auth_required" }, { status: 401 }) };
    const rl = await rateLimit("musicPlaylist", user.userId);
    if (!rl.success) return { response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };
    const track = await getTrackBySlug(slug);
    if (!track || track.status !== "published") return { response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
    return { userId: user.userId, trackId: track.id };
}

export const POST = withErrorHandling(async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const r = await resolve(slug);
    if ("response" in r) return r.response;
    const playlistId = await ensureLikedPlaylist(r.userId);
    await addToPlaylist(playlistId, r.trackId);
    return new NextResponse(null, { status: 204 });
});

export const DELETE = withErrorHandling(async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const r = await resolve(slug);
    if ("response" in r) return r.response;
    const playlistId = await ensureLikedPlaylist(r.userId);
    await removeFromPlaylist(playlistId, r.trackId);
    return new NextResponse(null, { status: 204 });
});
