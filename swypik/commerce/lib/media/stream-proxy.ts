/**
 * Proxy-ul comun Movies + Music pentru media plătită — DOAR DEZVOLTARE
 * (MinIO local, fără Worker-ul de CDN). În producție rutele de stream răspund
 * 404 (`isServerMediaProxyAllowed`), iar media plătită se servește direct de
 * pe CDN prin URL-uri semnate (`lib/media/signed-media.ts`).
 *
 * Clientul vede doar `/api/<vertical>/stream/<token>/<cale relativă>`; serverul
 * citește obiectul din bucket printr-un URL GET presemnat cu durată de
 * `MEDIA_UPSTREAM_SIGN_TTL_S` (clientul intern S3), deci obiectele pot sta
 * într-un prefix NEPUBLIC (vezi `MEDIA_PRIVATE_PREFIX`). Pentru URL-uri din
 * afara bucket-ului nostru (importuri vechi) se face fetch direct.
 * Playlist-urile HLS se rescriu ca fiecare segment să treacă tot prin proxy.
 */
import { NextResponse } from "next/server";
import { rewriteHlsPlaylist } from "./hls-rewrite";
import { toProxyPath } from "./stream-path";
import { createPresignedGetUrl, objectKeyFromAssetUrl } from "@/lib/storage/video-storage";
import { intEnv } from "@/lib/config/env";

/** Cât trăiește semnătura GET folosită de server spre bucket (doar server → storage). */
export const MEDIA_UPSTREAM_SIGN_TTL_S = intEnv("MEDIA_UPSTREAM_SIGN_TTL_S", 60, 10, 900);
/** Cache-ul segmentelor în browser: privat (niciodată CDN partajat). */
const SEGMENT_CACHE_SECONDS = 300;
const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

/** Prefixul cheilor care NU au acces anonim în bucket (politica o setează ownerul). */
export function mediaPrivatePrefix(): string {
    const raw = (process.env.MEDIA_PRIVATE_PREFIX || "private/").trim();
    return raw.endsWith("/") ? raw : `${raw}/`;
}

/** URL-ul indică un obiect din prefixul privat al bucket-ului nostru. */
export function isPrivateMediaUrl(url: string): boolean {
    const key = objectKeyFromAssetUrl(url);
    return key !== null && key.startsWith(mediaPrivatePrefix());
}

/** URL-ul efectiv folosit de server: presemnat dacă obiectul e în bucket-ul nostru. */
export async function upstreamFetchUrl(target: string): Promise<string> {
    const key = objectKeyFromAssetUrl(target);
    return key ? createPresignedGetUrl(key, MEDIA_UPSTREAM_SIGN_TTL_S) : target;
}

export type ProxyMediaArgs = {
    req: Request;
    token: string;
    /** URL-ul logic (public-form) al obiectului cerut — după validarea căii. */
    target: string;
    /** URL-ul logic al fișierului de bază (directorul lui delimitează ce se poate cere). */
    baseUrl: string;
    routePrefix: string;
};

export async function proxyMediaResponse({ req, token, target, baseUrl, routePrefix }: ProxyMediaArgs): Promise<NextResponse> {
    const range = req.headers.get("range");
    const upstream = await fetch(await upstreamFetchUrl(target), { headers: range ? { range } : {}, cache: "no-store" });
    if (!upstream.ok && upstream.status !== 206) return NextResponse.json({ error: "upstream" }, { status: 502 });

    const contentType = upstream.headers.get("content-type") ?? "";
    const isPlaylist = /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(target);
    if (isPlaylist) {
        const text = await upstream.text();
        const rewritten = rewriteHlsPlaylist(text, target, (abs) => toProxyPath(token, abs, baseUrl, routePrefix));
        return new NextResponse(rewritten, {
            status: 200,
            headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "private, no-store" },
        });
    }
    const headers = new Headers({ "cache-control": `private, max-age=${SEGMENT_CACHE_SECONDS}` });
    for (const h of PASSTHROUGH_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
}
