import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { createAlbum, isArtist, listArtistAlbums } from "@/lib/music/repository";
import { clampTrackPriceCents } from "@/lib/music/pricing";
import { slugifyMusic } from "@/lib/music/slug";

export const dynamic = "force-dynamic";

const CreateAlbumSchema = z.object({
    title: z.string().trim().min(2).max(120),
    coverUrl: z.string().url().max(500).nullable().default(null),
    releaseDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    priceCents: z.coerce.number().int().nullable().default(null),
});

export const GET = withErrorHandling(async function GET() {
    if (!isEnabled("music")) return frozenResponse("music");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isArtist(userId))) return NextResponse.json({ error: "not_an_artist" }, { status: 403 });

    const albums = await listArtistAlbums(userId, false);
    return NextResponse.json({ albums });
});

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isArtist(userId))) return NextResponse.json({ error: "not_an_artist" }, { status: 403 });

    const rl = await rateLimit("musicPublish", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(CreateAlbumSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const d = parsed.data;

    const album = await createAlbum({
        artistUserId: userId,
        title: d.title,
        slug: slugifyMusic(d.title, "album"),
        coverUrl: d.coverUrl,
        releaseDate: d.releaseDate,
        priceUnits: null,
        priceCents: d.priceCents !== null ? clampTrackPriceCents(d.priceCents) : null,
    });
    return NextResponse.json({ album }, { status: 201 });
});
