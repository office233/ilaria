import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { deletePlaylist, getLikedTrackIds, getPlaylist, listPlaylistTracks, renamePlaylist } from "@/lib/music/repository";
import { buildMusicViewer } from "@/lib/music/viewer";
import { toTrackDto } from "@/lib/music/dto";

export const dynamic = "force-dynamic";

// `id`-ul vine dintr-o coloană uuid — un id malformat ar arunca eroare SQL în
// loc de "not found", deci se validează înainte de orice interogare.
const IdSchema = z.string().uuid();
const BodySchema = z.object({ title: z.string().trim().min(1).max(80) });

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const { id } = await params;
    if (!IdSchema.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });

    const playlist = await getPlaylist(id, user.userId);
    if (!playlist) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const tracks = await listPlaylistTracks(id);
    const [viewer, likedIds] = await Promise.all([
        buildMusicViewer(user.userId, user.isAdmin),
        getLikedTrackIds(user.userId, tracks.map((t) => t.id)),
    ]);

    return NextResponse.json({
        playlist,
        tracks: tracks.map((t) => toTrackDto(t, viewer, likedIds.has(t.id))),
    });
});

export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const { id } = await params;
    if (!IdSchema.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("musicPlaylist", user.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const ok = await renamePlaylist(id, user.userId, parsed.data.title);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
});

export const DELETE = withErrorHandling(async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const { id } = await params;
    if (!IdSchema.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("musicPlaylist", user.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const playlist = await getPlaylist(id, user.userId);
    if (!playlist) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (playlist.is_liked_list) return NextResponse.json({ error: "liked_list" }, { status: 409 });

    const ok = await deletePlaylist(id, user.userId);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
});
