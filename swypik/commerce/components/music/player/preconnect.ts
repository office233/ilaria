"use client";

/**
 * Preconnect + dns-prefetch pentru hosturile de stream, la intenția userului (hover/focus)
 * sau pentru piesa următoare din coadă. Maxim STREAM_PRECONNECT_MAX_LINKS origin-uri vii în
 * `<head>` (LRU): cele mai vechi tag-uri sunt scoase.
 */
import { useCallback, useMemo } from "react";
import { STREAM_PRECONNECT_MAX_LINKS } from "@/lib/music/player/config";
import { planPreconnect, streamCandidates, streamOrigins } from "@/lib/music/player/stream-hosts";
import type { TrackDto } from "@/lib/music/types";

const LINK_ATTR = "data-swypik-stream-preconnect";

let active: string[] = [];

function linksFor(origin: string): HTMLLinkElement[] {
    return Array.from(document.head.querySelectorAll<HTMLLinkElement>(`link[${LINK_ATTR}]`)).filter(
        (el) => el.getAttribute(LINK_ATTR) === origin,
    );
}

function appendLink(rel: "preconnect" | "dns-prefetch", origin: string): void {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = origin;
    if (rel === "preconnect") link.crossOrigin = "anonymous";
    link.setAttribute(LINK_ATTR, origin);
    document.head.appendChild(link);
}

/** Preconectează origin-urile URL-urilor date (dedup, limită LRU). Fără efect pe server. */
export function preconnectStreamUrls(urls: readonly string[]): void {
    if (typeof document === "undefined" || urls.length === 0) return;
    const origins = streamOrigins(urls, window.location.origin);
    if (origins.length === 0) return;
    const plan = planPreconnect(active, origins, STREAM_PRECONNECT_MAX_LINKS);
    for (const origin of plan.remove) linksFor(origin).forEach((el) => el.remove());
    for (const origin of plan.add) {
        appendLink("preconnect", origin);
        appendLink("dns-prefetch", origin);
    }
    active = plan.next;
}

export function preconnectTrack(track: Pick<TrackDto, "streamUrl" | "streamUrlFallbacks"> | null | undefined): void {
    if (!track?.streamUrl) return;
    preconnectStreamUrls(streamCandidates(track));
}

export type PreconnectHandlers = { onPointerEnter: () => void; onFocus: () => void };

/** Handleri de intenție (hover/focus) pentru cardurile de stație/piesă. */
export function usePreconnectStream(track: Pick<TrackDto, "streamUrl" | "streamUrlFallbacks"> | null | undefined): PreconnectHandlers {
    const streamUrl = track?.streamUrl;
    const fallbacks = track?.streamUrlFallbacks;
    const warm = useCallback(() => preconnectTrack({ streamUrl, streamUrlFallbacks: fallbacks }), [streamUrl, fallbacks]);
    return useMemo(() => ({ onPointerEnter: warm, onFocus: warm }), [warm]);
}
