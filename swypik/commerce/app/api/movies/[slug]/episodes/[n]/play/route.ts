import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { getSeriesBySlug, getEpisode, getEpisodeById, listEpisodes } from "@/lib/movies/repository";
import { buildViewerContext } from "@/lib/movies/viewer";
import { canPlay, isFreeEpisode, isSeriesPublic } from "@/lib/movies/access";
import { seasonPriceCents } from "@/lib/movies/pricing";
import { signStreamToken } from "@/lib/media/stream-token";
import { MOVIES_STREAM_FALLBACK_DURATION_S, MOVIES_STREAM_TOKEN_TTL_S } from "@/lib/movies/config";
import { ensureEpisodeMediaPrivate } from "@/lib/movies/private-media";
import { publicEpisodeThumbnail } from "@/lib/movies/dto";
import { getStreamSecret } from "@/lib/media/stream-secret";
import { mediaBasename, STREAM_ROUTE_PREFIX } from "@/lib/media/stream-path";
import { isPrivateMediaUrl } from "@/lib/media/stream-proxy";
import { isServerMediaProxyAllowed, signedMediaUrl } from "@/lib/media/signed-media";
import { objectKeyFromAssetUrl } from "@/lib/storage/video-storage";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Id-ul din token pentru vizitatorii anonimi (doar episoade gratuite stocate privat). */
const ANON_STREAM_SUBJECT = "anon";

/**
 * GET /api/movies/[slug]/episodes/[n]/play
 *
 * - episod blocat pentru viewer → 402 cu prețurile (fără nimic despre media);
 * - episod gratuit, stocat public → URL-ul public direct (identic cu feed-ul);
 * - orice episod plătit (sau gratuit stocat în prefixul privat) → URL semnat pe
 *   CDN (token criptat, legat de user + directorul episodului, expirabil; bytes
 *   direct din R2, nu prin server). Doar în dezvoltare: proxy-ul cu token HMAC.
 *   Răspunsul nu conține `videoId`, ca un cumpărător să nu poată deriva URL-ul permanent.
 */
export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ slug: string; n: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const { slug, n } = await params;
    const episodeNumber = Number(n);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const series = await getSeriesBySlug(slug);
    if (!series || !isSeriesPublic(series)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const episode = await getEpisode(series.id, episodeNumber);
    if (!episode || episode.status !== "published") return NextResponse.json({ error: "not_found" }, { status: 404 });

    const user = await getAuthUser();
    const viewer = await buildViewerContext(user.userId, user.isAdmin, series.id);
    if (!canPlay(viewer, series, episode)) {
        const total = (await listEpisodes(series.id, { publishedOnly: true })).length;
        return NextResponse.json({
            error: "locked",
            // Preț RON (cenți) — deblocarea se plătește cu cardul (Stripe).
            priceCents: series.episode_price_cents,
            seasonPriceCents: seasonPriceCents(series, total),
            requireAuth: !user.userId,
        }, { status: 402 });
    }

    let full = await getEpisodeById(episode.id);
    if (!full?.playback_url) return NextResponse.json({ error: "not_ready" }, { status: 409 });
    const free = isFreeEpisode(series, episode);

    if (free && !isPrivateMediaUrl(full.playback_url)) {
        return NextResponse.json({ videoId: full.video_id, playbackUrl: full.playback_url, poster: full.thumbnail_url, expiresAt: null });
    }
    if (!free && !isPrivateMediaUrl(full.playback_url)) {
        // P0: un episod plătit NU se servește din prefixul public — îl mutăm acum (plasă de siguranță).
        const outcome = await ensureEpisodeMediaPrivate(full.video_id).catch((err) => {
            logger.error({ err, episodeId: episode.id }, "[movies] inline privatize failed");
            return "failed" as const;
        });
        full = outcome === "moved" ? await getEpisodeById(episode.id) : full;
        if (!full?.playback_url || !isPrivateMediaUrl(full.playback_url)) {
            logger.error({ episodeId: episode.id, outcome }, "[movies] paid episode media is not private — refusing to serve");
            return NextResponse.json({ error: "not_ready" }, { status: 409 });
        }
    }
    const poster = publicEpisodeThumbnail(full.thumbnail_url, !free);
    // Token-ul trebuie să acopere redarea întregului episod (segmentele se cer pe parcurs);
    // fără durată cunoscută, o durată de rezervă din config (altfel filmul se oprea după TTL).
    const durationMs = full.duration_ms ?? MOVIES_STREAM_FALLBACK_DURATION_S * 1000;
    const expiresAt = Date.now() + durationMs + MOVIES_STREAM_TOKEN_TTL_S * 1000;
    const subject = user.userId ?? ANON_STREAM_SUBJECT;
    // Producție: URL semnat pe CDN (Worker + R2) care acoperă directorul episodului.
    const key = objectKeyFromAssetUrl(full.playback_url);
    const signed = key ? signedMediaUrl({ key, scope: "directory", expiresAtMs: expiresAt, userId: subject }) : null;
    if (signed) return NextResponse.json({ playbackUrl: signed, poster, expiresAt });
    if (!isServerMediaProxyAllowed()) {
        logger.error({ episodeId: episode.id, inBucket: key !== null }, "[movies] private media signing unavailable (MEDIA_SIGNING_SECRET / bucket URL)");
        return NextResponse.json({ error: "media_unavailable" }, { status: 503 });
    }
    // Dezvoltare (MinIO local, fără Worker): proxy-ul cu token HMAC din aplicație.
    const token = signStreamToken({ userId: subject, scope: "movies", mediaId: episode.id, expiresAt }, getStreamSecret());
    return NextResponse.json({
        playbackUrl: `${STREAM_ROUTE_PREFIX}/${token}/${mediaBasename(full.playback_url)}`,
        poster,
        expiresAt,
    });
});
