import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { dbQuery } from "@/lib/db";
import { logAdminAction } from "@/lib/security/admin-audit";
import { getArtistByUserId, listArtistsForAdmin, removeArtist, upsertArtist } from "@/lib/music/repository";
import { slugifyMusic } from "@/lib/music/slug";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json({ artists: await listArtistsForAdmin() });
});

const CreateArtistSchema = z.object({
    userId: z.string().uuid(),
    stageName: z.string().trim().min(2).max(80),
    bio: z.string().trim().max(2000).default(""),
    avatarUrl: z.string().url().nullable().default(null),
    coverUrl: z.string().url().nullable().default(null),
});

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const parsed = parseBody(CreateArtistSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const { rows } = await dbQuery(`SELECT 1 FROM users WHERE id = $1`, [parsed.data.userId]);
    if (!rows.length) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

    // Slug-ul rămâne cel inițial dacă artistul există deja (link-urile nu se rup).
    const existing = await getArtistByUserId(parsed.data.userId);
    const slug = existing?.slug ?? slugifyMusic(parsed.data.stageName, "artist");

    const artist = await upsertArtist({
        userId: parsed.data.userId,
        stageName: parsed.data.stageName,
        slug,
        bio: parsed.data.bio,
        avatarUrl: parsed.data.avatarUrl,
        coverUrl: parsed.data.coverUrl,
        // Admin prin secret Bearer (fără sesiune) ⇒ approved_by rămâne NULL.
        approvedBy: auth.userId,
    });
    await logAdminAction({ action: "music_artist.approve", targetType: "user", targetId: parsed.data.userId, details: { stageName: parsed.data.stageName }, req });
    return NextResponse.json({ artist }, { status: 201 });
});

const DeleteArtistSchema = z.object({ userId: z.string().uuid() });

export const DELETE = withErrorHandling(async function DELETE(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const parsed = parseBody(DeleteArtistSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    await removeArtist(parsed.data.userId);
    await logAdminAction({ action: "music_artist.remove", targetType: "user", targetId: parsed.data.userId, req });
    return new NextResponse(null, { status: 204 });
});
