import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { rateLimit } from "@/lib/security/rate-limit";
import { getTrackById, isArtist, ownsAlbum, updateTrack, type TrackPatch } from "@/lib/music/repository";
import { archiveTrack, updateTrackAndSync } from "@/lib/music/publish";
import { canBecomePremium } from "@/lib/music/access";
import { clampTrackPriceCents } from "@/lib/music/pricing";
import { MUSIC_DEFAULT_TRACK_PRICE_CENTS, MUSIC_TRACK_PRICE_MIN_UNITS } from "@/lib/music/config";
import { MUSIC_GENRES } from "@/lib/music/genres";
import { trackEditNeedsReview } from "@/lib/music/review";
import { getVideoAssetUrl } from "@/lib/storage/video-storage";

export const dynamic = "force-dynamic";

const PatchTrackSchema = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    genre: z.enum(MUSIC_GENRES).optional(),
    explicit: z.boolean().optional(),
    isPremium: z.boolean().optional(),
    priceCents: z.coerce.number().int().optional(),
    allowReels: z.boolean().optional(),
    audience: z.enum(["general", "kids"]).optional(),
    coverUrl: z.string().url().startsWith("https://").max(500).nullable().optional(),
    albumId: z.string().uuid().nullable().optional(),
    trackNumber: z.coerce.number().int().min(1).nullable().optional(),
    licenseNote: z.string().trim().min(10).max(1000).optional(),
    /** Singura tranziție de status pe care o poate face artistul — publicarea e a adminului. */
    status: z.literal("archived").optional(),
});

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isArtist(userId))) return NextResponse.json({ error: "not_an_artist" }, { status: 403 });

    const { id } = await params;
    const track = await getTrackById(id);
    if (!track || track.artist_user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ track });
});

/**
 * Editează o piesă proprie. Arhivarea (`status: "archived"`) trece prin
 * `archiveTrack`, care dezactivează sunetul din reels în aceeași tranzacție —
 * restul câmpurilor sunt ignorate pe acea cerere.
 *
 * Schimbarea `isPremium` recalculează `priceUnits`/`publicUrl` exact ca la
 * creare (premium ⇒ fără URL public, deci nu poate deveni niciodată sunet).
 * Dacă piesa e deja publicată și s-a schimbat oricare din
 * isPremium/allowReels/title/coverUrl/genre, `resyncTrackSound` aliniază
 * `audio_tracks` cu noua stare (Review Focus #3 și #4 din plan).
 */
export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isArtist(userId))) return NextResponse.json({ error: "not_an_artist" }, { status: 403 });
    const rl = await rateLimit("creatorVideoEdit", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { id } = await params;
    const parsed = parseBody(PatchTrackSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const d = parsed.data;

    if (d.status === "archived") {
        const archived = await archiveTrack(id, userId);
        if (!archived) return NextResponse.json({ error: "not_found" }, { status: 404 });
        return NextResponse.json({ track: archived });
    }

    const existing = await getTrackById(id);
    if (!existing || existing.artist_user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });

    if (d.albumId !== undefined && d.albumId !== null && !(await ownsAlbum(d.albumId, userId))) {
        return NextResponse.json({ error: "album_not_owned" }, { status: 403 });
    }

    const patch: TrackPatch = {
        title: d.title,
        genre: d.genre,
        explicit: d.explicit,
        allowReels: d.allowReels,
        audience: d.audience,
        coverUrl: d.coverUrl,
        albumId: d.albumId,
        trackNumber: d.trackNumber,
        licenseNote: d.licenseNote,
    };
    // Free -> premium după publicare ar vinde un fișier al cărui URL public a fost deja difuzat.
    if (d.isPremium === true && !canBecomePremium(existing)) {
        return NextResponse.json({ error: "already_public" }, { status: 409 });
    }

    const willBePremium = d.isPremium ?? existing.is_premium;
    if (d.isPremium !== undefined) {
        patch.isPremium = d.isPremium;
        patch.publicUrl = d.isPremium ? null : getVideoAssetUrl(existing.object_key);
    }
    // Prețul RON se poate schimba și singur, pe o piesă deja premium; pe una gratuită rămâne NULL.
    if (willBePremium) {
        // Legacy: coloana SWYP e obligatorie când e premium (constrângere veche a schemei) — placeholder nefolosit de UI.
        if (d.isPremium !== undefined) patch.priceUnits = existing.price_units ?? MUSIC_TRACK_PRICE_MIN_UNITS;
        if (d.isPremium !== undefined || d.priceCents !== undefined) {
            patch.priceCents = clampTrackPriceCents(d.priceCents ?? existing.price_cents ?? MUSIC_DEFAULT_TRACK_PRICE_CENTS);
        }
    } else if (d.isPremium === false) {
        patch.priceUnits = null;
        patch.priceCents = null;
    }

    // Conținut vizibil schimbat pe o piesă publicată → re-moderare; sincronizarea de mai
    // jos îi dezactivează sunetul din reels până la re-aprobare.
    const reReview = trackEditNeedsReview(existing, d);
    if (reReview) {
        patch.status = "pending_review";
        patch.moderationStatus = "pending_review";
    }

    // Pe o piesă publicată, schimbările care ating sunetul din reels se aplică
    // împreună cu sincronizarea audio_tracks, într-o singură tranzacție.
    const affectsSound = reReview || d.isPremium !== undefined || d.allowReels !== undefined
        || d.title !== undefined || d.coverUrl !== undefined || d.genre !== undefined;
    const updated = existing.status === "published" && affectsSound
        ? await updateTrackAndSync(id, userId, patch)
        : await updateTrack(id, userId, patch);
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({ track: updated, reReview });
});
