"use client";

import { useCallback, useMemo, useState, type ImgHTMLAttributes } from "react";
import { VIDEO_PLAYBACK } from "@/lib/config/video-playback";
import { mediaImageUrl } from "@/lib/storage/image-loader";
import type { FeedItem } from "@/lib/feed/types";
import { hintIndexes, isHlsUrl, posterWidth, slotState, type SlotState } from "@/lib/video/feed-preload";
import { useNetworkConstrained } from "@/lib/video/useNetworkConstrained";
import { useFeedPrefetch, type PrefetchHint } from "./useFeedPrefetch";

function viewportPosterWidth(): number {
  if (typeof window === "undefined") return VIDEO_PLAYBACK.defaultPosterWidth;
  return posterWidth(window.innerWidth, window.devicePixelRatio);
}

/**
 * Atributele de încărcare ale posterului: primul slide = LCP (eager + prioritate
 * mare), restul lazy. React 18 nu cunoaște `fetchPriority` → atributul HTML direct.
 */
export function posterImgProps(priority: boolean): ImgHTMLAttributes<HTMLImageElement> {
  if (!priority) return { loading: "lazy", decoding: "async" };
  return { loading: "eager", decoding: "async", ...({ fetchpriority: "high" } as ImgHTMLAttributes<HTMLImageElement>) };
}

/**
 * Planul de preîncărcare al feed-ului: starea fiecărui slide (active/preload/idle),
 * URL-ul posterului (transformat pe CDN la lățimea ecranului) și prefetch-ul
 * manifestelor / posterelor pentru clipurile de după vecinul atașat.
 */
export function useFeedPreload(items: readonly FeedItem[], active: number) {
  const constrained = useNetworkConstrained();
  // O singură lățime per sesiune: aceeași adresă pentru <img>, poster și prefetch → un singur download.
  const [width] = useState(viewportPosterWidth);

  const posterSrc = useCallback(
    (thumbnail: string | null): string | null => (thumbnail ? mediaImageUrl(thumbnail, width, VIDEO_PLAYBACK.posterQuality) : null),
    [width],
  );

  const slotFor = useCallback((index: number): SlotState => slotState(index, active, constrained), [active, constrained]);

  const hints = useMemo(() => {
    const out: PrefetchHint[] = [];
    for (const idx of hintIndexes(active, items.length, constrained)) {
      const item = items[idx];
      if (item?.kind !== "video") continue;
      const poster = posterSrc(item.video.thumbnail);
      if (poster) out.push({ href: poster, cors: false });
      const manifest = item.video.hlsUrl || item.video.url;
      if (manifest && isHlsUrl(manifest)) out.push({ href: manifest, cors: true });
    }
    return out;
  }, [items, active, constrained, posterSrc]);

  useFeedPrefetch(hints);

  return { slotFor, posterSrc };
}
