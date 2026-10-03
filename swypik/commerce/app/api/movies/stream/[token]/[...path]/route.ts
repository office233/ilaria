import { NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { verifyStreamToken } from "@/lib/media/stream-token";
import { getStreamSecret } from "@/lib/media/stream-secret";
import { resolveEpisodeMediaUrl, STREAM_ROUTE_PREFIX } from "@/lib/media/stream-path";
import { proxyMediaResponse } from "@/lib/media/stream-proxy";
import { isServerMediaProxyAllowed } from "@/lib/media/signed-media";
import { getEpisodeById } from "@/lib/movies/repository";

export const dynamic = "force-dynamic";

/**
 * GET /api/movies/stream/[token]/[...path]
 *
 * Token HMAC (user + episod, expiră) + cale RELATIVĂ la directorul episodului.
 * URL-ul real al episodului vine din DB pe baza token-ului și nu ajunge
 * niciodată la client; orice cale care iese din director este refuzată.
 * Obiectele se citesc prin URL presemnat (pot sta într-un prefix nepublic).
 */
export const GET = withErrorHandling(async function GET(req: Request, { params }: { params: Promise<{ token: string; path: string[] }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    // Proxy de bytes doar în dezvoltare; în producție media vine semnată de pe CDN.
    if (!isServerMediaProxyAllowed()) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const { token, path } = await params;
    const payload = verifyStreamToken(token, getStreamSecret());
    if (!payload || payload.scope !== "movies") return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const rl = await rateLimit("moviesStream", `${payload.userId}:${payload.mediaId}`);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const episode = await getEpisodeById(payload.mediaId);
    if (!episode?.playback_url) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const target = resolveEpisodeMediaUrl(episode.playback_url, path.join("/"));
    if (!target) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    return proxyMediaResponse({ req, token, target, baseUrl: episode.playback_url, routePrefix: STREAM_ROUTE_PREFIX });
});
