import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { createPlaylist, listPlaylists } from "@/lib/music/repository";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ title: z.string().trim().min(1).max(80) });

export const GET = withErrorHandling(async function GET() {
    if (!isEnabled("music")) return frozenResponse("music");
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const playlists = await listPlaylists(user.userId);
    return NextResponse.json({ playlists });
});

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("musicPlaylist", user.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const playlist = await createPlaylist(user.userId, parsed.data.title);
    return NextResponse.json({ playlist }, { status: 201 });
});
