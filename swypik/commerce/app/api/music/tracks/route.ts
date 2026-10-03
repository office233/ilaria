import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { MUSIC_CATALOG_PAGE_SIZE } from "@/lib/music/config";
import { MUSIC_GENRES } from "@/lib/music/genres";
import { listTracks, getLikedTrackIds } from "@/lib/music/repository";
import { toTrackDto } from "@/lib/music/dto";
import { buildMusicViewer } from "@/lib/music/viewer";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
    genre: z.enum(MUSIC_GENRES).optional(),
    sort: z.enum(["trending", "new"]).default("trending"),
    q: z.string().trim().max(80).optional(),
    offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const rl = await rateLimit("musicCatalog", getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    const { genre, sort, q, offset } = parsed.data;

    let items: Awaited<ReturnType<typeof listTracks>> = [];
    let likedIds = new Set<string>();

    try {
        const user = await getAuthUser();
        const viewer = await buildMusicViewer(user.userId, user.isAdmin);
        items = await listTracks({ genre, sort, q, limit: MUSIC_CATALOG_PAGE_SIZE, offset });
        if (user.userId && items.length > 0) {
            likedIds = await getLikedTrackIds(user.userId, items.map((t) => t.id)).catch(() => new Set<string>());
        }

        return NextResponse.json({ items: items.map((t) => toTrackDto(t, viewer, likedIds.has(t.id))) });
    } catch {
        // Fallback dacă DB local e gol sau indisponibil
    }

    return NextResponse.json({ items: [] });
});
