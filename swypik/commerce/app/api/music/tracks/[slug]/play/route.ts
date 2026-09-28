import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { getTrackBySlug, getAlbumById, listAlbumTracks } from "@/lib/music/repository";
import { buildMusicViewer } from "@/lib/music/viewer";
import { canStream } from "@/lib/music/access";
import { albumPriceCents as computeAlbumPriceCents } from "@/lib/music/pricing";
import { MUSIC_STREAM_TOKEN_TTL_S } from "@/lib/music/config";
import { signStreamToken } from "@/lib/media/stream-token";
import { getStreamSecret } from "@/lib/media/stream-secret";
import { MUSIC_STREAM_FILE, MUSIC_STREAM_ROUTE_PREFIX } from "@/lib/media/stream-path";
import { isServerMediaProxyAllowed, signedMediaUrl } from "@/lib/media/signed-media";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const rl = await rateLimit("musicPlay", getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { slug } = await params;
    const track = await getTrackBySlug(slug);
    if (!track) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const user = await getAuthUser();
    const viewer = await buildMusicViewer(user.userId, user.isAdmin);

    if (!canStream(viewer, track)) {
        const album = track.album_id ? await getAlbumById(track.album_id) : null;
        const albumTracks = album ? await listAlbumTracks(album.id, true) : [];
        return NextResponse.json({
            error: "locked",
            // Preț RON (cenți) — deblocarea se plătește cu cardul (Stripe).
            priceCents: track.price_cents,
            albumPriceCents: album ? computeAlbumPriceCents(album, albumTracks) : null,
            requireAuth: !user.userId,
        }, { status: 402 });
    }

    if (!track.is_premium) {
        if (!track.public_url) return NextResponse.json({ error: "not_ready" }, { status: 409 });
        return NextResponse.json({ url: track.public_url, expiresAt: null });
    }

    const expiresAt = Date.now() + MUSIC_STREAM_TOKEN_TTL_S * 1000;
    const subject = user.userId ?? "admin";
    // Producție: URL semnat pe CDN (Worker + R2); token-ul e criptat, deci cheia
    // reală (basename aleator) nu ajunge la client.
    const signed = signedMediaUrl({ key: track.object_key, scope: "object", expiresAtMs: expiresAt, userId: subject, displayName: MUSIC_STREAM_FILE });
    if (signed) return NextResponse.json({ url: signed, expiresAt });
    if (!isServerMediaProxyAllowed()) {
        logger.error({ trackId: track.id }, "[music] private media signing unavailable (MEDIA_SIGNING_SECRET)");
        return NextResponse.json({ error: "media_unavailable" }, { status: 503 });
    }
    // Dezvoltare (MinIO local, fără Worker): proxy-ul cu token HMAC din aplicație.
    const token = signStreamToken({ userId: subject, scope: "music", mediaId: track.id, expiresAt }, getStreamSecret());
    // Segment constant: numele real al fișierului nu pleacă niciodată la client.
    const url = `${MUSIC_STREAM_ROUTE_PREFIX}/${token}/${MUSIC_STREAM_FILE}`;
    return NextResponse.json({ url, expiresAt });
});
