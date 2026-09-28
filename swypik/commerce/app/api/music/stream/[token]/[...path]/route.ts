import { NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { verifyStreamToken } from "@/lib/media/stream-token";
import { getStreamSecret } from "@/lib/media/stream-secret";
import { musicStreamTarget, MUSIC_STREAM_ROUTE_PREFIX } from "@/lib/media/stream-path";
import { proxyMediaResponse } from "@/lib/media/stream-proxy";
import { isServerMediaProxyAllowed } from "@/lib/media/signed-media";
import { getTrackById } from "@/lib/music/repository";
import { getVideoAssetUrl } from "@/lib/storage/video-storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/music/stream/[token]/[...path]
 *
 * Token HMAC (user + piesă, expiră) + cale RELATIVĂ la directorul piesei.
 * URL-ul real (din `object_key`) vine din DB pe baza token-ului și nu ajunge
 * niciodată la client; orice cale care iese din director este refuzată.
 * Obiectul se citește prin URL presemnat (poate sta într-un prefix nepublic).
 */
export const GET = withErrorHandling(async function GET(req: Request, { params }: { params: Promise<{ token: string; path: string[] }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    // Proxy de bytes doar în dezvoltare; în producție media vine semnată de pe CDN.
    if (!isServerMediaProxyAllowed()) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const { token, path } = await params;
    const payload = verifyStreamToken(token, getStreamSecret());
    if (!payload || payload.scope !== "music") return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const rl = await rateLimit("musicStream", `${payload.userId}:${payload.mediaId}`);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const track = await getTrackById(payload.mediaId);
    if (!track) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const baseUrl = getVideoAssetUrl(track.object_key);
    const target = musicStreamTarget(baseUrl, path.join("/"));
    if (!target) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    return proxyMediaResponse({ req, token, target, baseUrl, routePrefix: MUSIC_STREAM_ROUTE_PREFIX });
});
