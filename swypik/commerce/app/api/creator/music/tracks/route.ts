import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { createTrack, isArtist, ownsAlbum } from "@/lib/music/repository";
import { clampTrackPriceCents } from "@/lib/music/pricing";
import { slugifyMusic } from "@/lib/music/slug";
import { MUSIC_DEFAULT_TRACK_PRICE_CENTS, MUSIC_TRACK_PRICE_MIN_UNITS, MUSIC_MAX_DURATION_MS, MUSIC_MIN_DURATION_MS } from "@/lib/music/config";
import { MUSIC_GENRES } from "@/lib/music/genres";
import { isOwnedMusicKey } from "@/lib/storage/media-upload";
import { getVideoAssetUrl } from "@/lib/storage/video-storage";

export const dynamic = "force-dynamic";

const CreateTrackSchema = z.object({
    trackId: z.string().uuid(),
    objectKey: z.string().trim().min(1).max(500),
    title: z.string().trim().min(2).max(120),
    genre: z.enum(MUSIC_GENRES),
    durationMs: z.coerce.number().int().min(MUSIC_MIN_DURATION_MS).max(MUSIC_MAX_DURATION_MS),
    explicit: z.boolean().default(false),
    isPremium: z.boolean().default(false),
    priceCents: z.coerce.number().int().optional(),
    allowReels: z.boolean().default(true),
    audience: z.enum(["general", "kids"]).default("general"),
    albumId: z.string().uuid().nullable().default(null),
    trackNumber: z.coerce.number().int().min(1).nullable().default(null),
    coverUrl: z.string().url().max(500).nullable().default(null),
    licenseNote: z.string().trim().min(10).max(1000),
});

/**
 * Trimite o piesă nouă la review, după ce fișierul a fost deja urcat pe R2 via
 * `POST /api/creator/music/upload-url`. Piesele premium nu au niciodată
 * `public_url` — se redau exclusiv prin proxy-ul cu token (Task 6/7), ceea ce
 * garantează, alături de `audioTrackRowFor`, că nu ajung sunete premium în
 * `audio_tracks`.
 */
export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isArtist(userId))) return NextResponse.json({ error: "not_an_artist" }, { status: 403 });

    const rl = await rateLimit("musicPublish", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(CreateTrackSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const d = parsed.data;

    if (!isOwnedMusicKey(d.objectKey, userId)) {
        return NextResponse.json({ error: "invalid_key" }, { status: 400 });
    }
    if (d.albumId && !(await ownsAlbum(d.albumId, userId))) {
        return NextResponse.json({ error: "album_not_owned" }, { status: 403 });
    }

    const priceCents = d.isPremium ? clampTrackPriceCents(d.priceCents ?? MUSIC_DEFAULT_TRACK_PRICE_CENTS) : null;
    // Legacy: coloana SWYP e obligatorie când e premium (constrângere veche a schemei) — placeholder nefolosit de UI.
    const priceUnits = d.isPremium ? MUSIC_TRACK_PRICE_MIN_UNITS : null;
    const publicUrl = d.isPremium ? null : getVideoAssetUrl(d.objectKey);
    const slug = slugifyMusic(d.title, "track");

    const track = await createTrack({
        id: d.trackId,
        artistUserId: userId,
        albumId: d.albumId,
        trackNumber: d.trackNumber,
        title: d.title,
        slug,
        coverUrl: d.coverUrl,
        genre: d.genre,
        durationMs: d.durationMs,
        explicit: d.explicit,
        objectKey: d.objectKey,
        publicUrl,
        isPremium: d.isPremium,
        priceUnits,
        priceCents,
        allowReels: d.allowReels,
        audience: d.audience,
        licenseNote: d.licenseNote,
    });
    return NextResponse.json({ track }, { status: 201 });
});
