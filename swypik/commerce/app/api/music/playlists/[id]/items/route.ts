import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { addToPlaylist, getPlaylist, getTrackById, removeFromPlaylist } from "@/lib/music/repository";

export const dynamic = "force-dynamic";

const IdSchema = z.string().uuid();
const BodySchema = z.object({ trackId: z.string().uuid() });

type Resolved = { response: Response } | { trackId: string };

async function resolve(req: Request, playlistId: string, requireTrackPublished: boolean): Promise<Resolved> {
    if (!isEnabled("music")) return { response: frozenResponse("music") };
    if (!IdSchema.safeParse(playlistId).success) return { response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
    const user = await getAuthUser();
    if (!user.userId) return { response: NextResponse.json({ error: "auth_required" }, { status: 401 }) };
    const rl = await rateLimit("musicPlaylist", user.userId);
    if (!rl.success) return { response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };

    const playlist = await getPlaylist(playlistId, user.userId);
    if (!playlist) return { response: NextResponse.json({ error: "not_found" }, { status: 404 }) };

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return { response: NextResponse.json({ error: "invalid_body" }, { status: 400 }) };

    if (requireTrackPublished) {
        const track = await getTrackById(parsed.data.trackId);
        if (!track || track.status !== "published") {
            return { response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
        }
    }
    return { trackId: parsed.data.trackId };
}

export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const r = await resolve(req, id, true);
    if ("response" in r) return r.response;
    await addToPlaylist(id, r.trackId);
    return new NextResponse(null, { status: 204 });
});

export const DELETE = withErrorHandling(async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const r = await resolve(req, id, false);
    if ("response" in r) return r.response;
    await removeFromPlaylist(id, r.trackId);
    return new NextResponse(null, { status: 204 });
});
